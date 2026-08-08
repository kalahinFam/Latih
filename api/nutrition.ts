/**
 * Nutrition question answering, grounded in the TKPI table.
 *
 * ## The contract
 *
 * The model sees only the rows retrieved for this question, and every figure it
 * writes is checked against those rows before the answer reaches the user. An
 * answer containing a number that is not in the data is regenerated once under
 * a stricter instruction, and if it fails again the narrative is dropped and
 * the raw table is shown instead.
 *
 * That last step is the point. A nutrition assistant that occasionally invents
 * a plausible figure is worse than one that sometimes declines to write prose,
 * because the user cannot tell the two apart. Refusing is the honest failure.
 *
 * The user-facing citations are the same rows the verifier used, so anyone —
 * including a judge — can check the answer against the table in the UI.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { completeJson, errorResponse, json } from './_llm.ts';
import { numbersInQuestion, verifyGrounding } from '../web/src/core/grounding.ts';
import {
  MAX_QUESTION_CHARS,
  contextValues,
  formatContextForPrompt,
  formatTranscript,
  isChatContext,
  lastUserMessage,
  sanitizeHistory,
  type ChatContext,
  type ChatTurn,
} from '../web/src/core/nutritionChat.ts';
import {
  allowedValuesFor,
  findFoodsForQuestion,
  formatForPrompt,
  hasUnverified,
  type TkpiFood,
  type TkpiTable,
} from '../web/src/core/tkpi.ts';

export const config = { runtime: 'nodejs' };

const DATA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'tkpi',
  'tkpi.json',
);

let cached: TkpiTable | null = null;

async function loadTable(): Promise<TkpiTable> {
  // Read once per warm instance. The file is small and immutable at runtime.
  if (!cached) cached = JSON.parse(await readFile(DATA_PATH, 'utf8')) as TkpiTable;
  return cached;
}

interface NutritionOutput {
  jawaban: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    jawaban: {
      type: 'string',
      description: 'Jawaban ringkas dalam Bahasa Indonesia, maksimal tiga kalimat.',
    },
  },
  required: ['jawaban'],
  additionalProperties: false,
};

const SYSTEM = `Kamu asisten gizi yang menjawab berdasarkan Tabel Komposisi Pangan
Indonesia (TKPI).

ATURAN MUTLAK:
- Setiap angka yang kamu tulis HARUS berasal persis dari data yang diberikan,
  termasuk angka target harian pengguna kalau memang disertakan.
- DILARANG menghitung, menjumlahkan, mengalikan, atau memperkirakan angka baru.
  Kalau pengguna bertanya untuk 150 gram sedangkan data per 100 gram, katakan
  angkanya per 100 gram dan jelaskan bahwa itu basis datanya — jangan dikalikan.
- DILARANG memakai angka dari pengetahuanmu sendiri. Kalau data tidak memuat
  yang ditanyakan, katakan datanya tidak tersedia.
- Ini percakapan: kalau pertanyaan terakhir merujuk ke bahan yang dibahas
  sebelumnya, jawab tentang bahan itu. Jangan mengulang jawaban sebelumnya.
- Bahasa Indonesia sehari-hari, maksimal tiga kalimat.
- Jangan memberi saran medis atau klaim kesehatan.`;

const STRICTER_SUFFIX = `

PERINGATAN: Jawaban sebelumnya memuat angka yang TIDAK ada di data. Tulis ulang
dan gunakan HANYA angka yang tertulis persis di data di bawah. Kalau ragu,
sebutkan lebih sedikit angka.`;

function buildPrompt(
  question: string,
  foods: TkpiFood[],
  history: ChatTurn[],
  context: ChatContext | undefined,
): string {
  const parts = [`Data TKPI yang tersedia:\n\n${formatForPrompt(foods)}`];

  const plan = formatContextForPrompt(context);
  if (plan) parts.push(plan);

  if (history.length > 0) parts.push(`Percakapan sebelumnya:\n${formatTranscript(history)}`);

  parts.push(`Pertanyaan pengguna: ${question}`);
  return parts.join('\n\n');
}

/** Rows sent to the client so the user can check the answer themselves. */
function toCitations(foods: TkpiFood[]) {
  return foods.map((food) => ({
    code: food.code,
    name: food.name,
    basisG: food.basisG,
    energyKcal: food.energyKcal,
    proteinG: food.proteinG,
    fatG: food.fatG,
    carbG: food.carbG,
    fiberG: food.fiberG,
    source: food.source,
    verified: food.verified,
  }));
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Gunakan POST.' }, 405);

  let payload: { question?: unknown; history?: unknown; context?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return json({ error: 'Body bukan JSON yang sah.' }, 400);
  }

  const { question } = payload;
  if (typeof question !== 'string' || question.trim().length === 0) {
    return json({ error: 'Field "question" wajib diisi.' }, 400);
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return json({ error: `Pertanyaan maksimal ${MAX_QUESTION_CHARS} karakter.` }, 413);
  }
  if (!isChatContext(payload.context)) {
    return json({ error: 'Field "context" tidak valid.' }, 400);
  }

  // Trimmed and truncated before it reaches a prompt: this arrives over HTTP,
  // so its length is somebody else's decision until it has been through here.
  const history = sanitizeHistory(payload.history);
  const context = payload.context as ChatContext | undefined;

  try {
    const table = await loadTable();
    let foods = findFoodsForQuestion(table, question);

    // A follow-up carries no nouns — "kalau tahu?", "berapa proteinnya?" — so
    // when the question alone retrieves nothing, try it together with what was
    // asked before. Only then: every extra row widens the set of numbers the
    // verifier accepts, and that set is the guarantee.
    const previous = lastUserMessage(history);
    if (foods.length === 0 && previous) {
      foods = findFoodsForQuestion(table, `${previous} ${question}`);
    }

    if (foods.length === 0) {
      // No model call: with no rows there is nothing to ground an answer in,
      // and asking anyway is precisely how a fabricated figure gets produced.
      return json({
        answer:
          'Bahan pangan itu belum ada di data TKPI yang tersedia. Coba sebutkan ' +
          'nama bahan yang lebih umum, misalnya tempe, tahu, telur, atau nasi.',
        citations: [],
        verification: { passed: true, checked: 0, unmatched: [], regenerated: false },
        dataWarning: null,
      });
    }

    // The table's numbers, plus the targets this app computed on the device.
    // Quoting back a figure already on the same screen is not a fabrication.
    const allowed = [...allowedValuesFor(foods), ...contextValues(context)];
    const questionValues = numbersInQuestion(question);
    const prompt = buildPrompt(question, foods, history, context);

    let result = await completeJson<NutritionOutput>({
      system: SYSTEM,
      user: prompt,
      schema: SCHEMA,
      schemaName: 'jawaban_gizi',
      maxTokens: 300,
    });
    let verification = verifyGrounding(result.data.jawaban, allowed, questionValues);
    let regenerated = false;

    if (!verification.passed) {
      // One retry under a stricter instruction. More than one would spend
      // latency and money to keep asking a model that has already shown it
      // will invent a figure for this question.
      regenerated = true;
      result = await completeJson<NutritionOutput>({
        system: SYSTEM + STRICTER_SUFFIX,
        user: prompt,
        schema: SCHEMA,
        schemaName: 'jawaban_gizi',
        maxTokens: 300,
      });
      verification = verifyGrounding(result.data.jawaban, allowed, questionValues);
    }

    const citations = toCitations(foods);
    const dataWarning = hasUnverified(foods)
      ? 'Sebagian data belum diverifikasi terhadap TKPI resmi.'
      : null;

    if (!verification.passed) {
      // Refuse the prose, keep the data. The user still gets the figures they
      // asked for, from a source they can check.
      return json({
        answer:
          'Jawaban otomatis tidak lolos pemeriksaan angka, jadi tidak ditampilkan. ' +
          'Berikut data mentah dari tabel:',
        citations,
        verification: {
          passed: false,
          checked: verification.claims.length,
          unmatched: verification.unmatched.map((c) => `${c.raw} ${c.unit}`),
          regenerated,
        },
        dataWarning,
      });
    }

    return json({
      answer: result.data.jawaban,
      citations,
      verification: {
        passed: true,
        checked: verification.claims.length,
        unmatched: [],
        regenerated,
      },
      dataWarning,
      usage: result.usage,
      latencyMs: result.latencyMs,
    });
  } catch (error) {
    return errorResponse(error, 'Asisten gizi sedang tidak bisa dihubungi.');
  }
}
