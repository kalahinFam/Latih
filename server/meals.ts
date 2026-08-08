/**
 * Daily meal suggestions, aligned with the training plan.
 *
 * ## What the model decides, and what it never touches
 *
 * The client sends a per-meal calorie budget — computed on the device in
 * `core/energy.ts` from the user's body profile, which never leaves the phone.
 * The model receives that budget and the pantry, and returns food codes and
 * portions in grams. Nothing else.
 *
 * Every figure the user sees is computed in `core/meals.ts` from the TKPI rows
 * the codes resolve to. This is the same lesson the coach endpoint learned
 * twice: a model asked to evaluate or compute a number produces one that reads
 * correctly and is wrong, and here the ordinary grounding verifier cannot even
 * catch it — a wrong *total* is built from component figures that are each
 * genuinely in the table.
 *
 * ## Why this is not medical advice, and how that is kept true
 *
 * The endpoint suggests foods and shows their composition. It does not
 * prescribe a diet, does not receive body measurements, and the calorie target
 * it works to has already been floored on the device so it can never describe
 * an unsafe intake. The prompt forbids health claims, and options that miss
 * their budget are rejected rather than shown with a disclaimer.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { completeJson, errorResponse, json } from './_llm.ts';
import { LIMITS, checkLimit } from './_ratelimit.ts';
import { verifyGrounding } from '../web/src/core/grounding.ts';
import { buildOptions, type ChosenOption, type MealOption } from '../web/src/core/meals.ts';
import { formatPantryForPrompt } from '../web/src/core/pantry.ts';
import { allowedValuesForPortions, type TkpiTable } from '../web/src/core/tkpi.ts';

export const config = { runtime: 'nodejs' };

const DATA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'tkpi', 'tkpi.json');

let cached: TkpiTable | null = null;

async function loadTable(): Promise<TkpiTable> {
  if (!cached) cached = JSON.parse(await readFile(DATA_PATH, 'utf8')) as TkpiTable;
  return cached;
}

const SLOTS = ['pagi', 'siang', 'malam'] as const;
type Slot = (typeof SLOTS)[number];

const SLOT_LABELS: Record<Slot, string> = {
  pagi: 'sarapan',
  siang: 'makan siang',
  malam: 'makan malam',
};

/** Budgets outside this range mean the client sent something wrong. */
const MIN_BUDGET_KCAL = 100;
const MAX_BUDGET_KCAL = 2000;

/**
 * Options requested per meal.
 *
 * Four, to show three, because a measurable share never survives validation.
 *
 * Measured against `gpt-4o-mini` over twelve meals: five options were rejected
 * for landing too far from their budget, always by undershooting, and the miss
 * grew with the budget. Adding the arithmetic hint to the prompt and asking for
 * a fourth option brought the rejection rate from 42% to 29% and stopped any
 * meal arriving with a single lonely suggestion. A separate rejection caught
 * the model inventing a TKPI code outright — which is the pantry check earning
 * its place, not a tuning problem.
 *
 * The residual 29% is the honest cost of asking a language model to satisfy an
 * arithmetic constraint. It is absorbed rather than hidden: the extra option
 * costs about $0.0001, and what reaches the user is only what validated.
 */
const OPTIONS_PER_MEAL = 4;

/** Never show more than this, however many survive. */
const MAX_OPTIONS_SHOWN = 3;

interface MealRequest {
  slot: Slot;
  budgetKcal: number;
  isTrainingDay: boolean;
  proteinTargetG?: number;
  /**
   * TKPI codes the user has ruled out, derived on the device from their
   * dietary restrictions.
   *
   * The codes travel, not the restrictions: "no seafood" is a fact about the
   * person, and a list of food codes is a fact about a menu. Only the second
   * needs to leave the phone.
   */
  excludeCodes?: string[];
  /** Codes to reach for first. A preference, never a filter. */
  preferCodes?: string[];
}

interface ModelOutput {
  opsi: ChosenOption[];
}

const SCHEMA = {
  type: 'object',
  properties: {
    opsi: {
      type: 'array',
      description: `Tepat ${OPTIONS_PER_MEAL} opsi menu yang berbeda.`,
      items: {
        type: 'object',
        properties: {
          nama: { type: 'string', description: 'Nama menu singkat, misalnya "Nasi telur tumis kangkung".' },
          items: {
            type: 'array',
            description: 'Bahan-bahan menu ini.',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string', description: 'Kode TKPI persis dari daftar bahan.' },
                grams: { type: 'number', description: 'Porsi dalam gram.' },
              },
              required: ['code', 'grams'],
              additionalProperties: false,
            },
          },
          catatan: { type: 'string', description: 'Satu kalimat kenapa menu ini cocok. Tanpa angka.' },
        },
        required: ['nama', 'items', 'catatan'],
        additionalProperties: false,
      },
    },
  },
  required: ['opsi'],
  additionalProperties: false,
};

const SYSTEM = `Kamu perencana menu harian untuk orang Indonesia yang sedang
menjalani program latihan.

Kamu memilih bahan dan porsinya. Kamu TIDAK menghitung apa pun.

ATURAN MUTLAK:
- Hanya boleh memakai kode bahan yang ada di daftar. Dilarang mengarang kode.
- DILARANG menulis angka kalori, protein, lemak, atau karbohidrat di mana pun,
  termasuk di dalam "nama" dan "catatan". Angka-angka itu dihitung oleh sistem
  dari tabel resmi, dan angka yang kamu tulis sendiri akan ditolak.
- Satu-satunya angka yang kamu tulis adalah porsi dalam gram di field "grams".
- Setiap opsi harus berupa menu yang masuk akal dimakan bersama dalam satu
  piring, bukan daftar bahan acak.
- Buat ketiga opsi benar-benar berbeda, jangan hanya menukar satu bahan.
- Susun porsi supaya totalnya mendekati target kalori yang diberikan. Kalau
  meleset jauh, opsimu akan dibuang.
- Sebelum mengirim, perkirakan kasar total tiap opsi: untuk tiap bahan hitung
  (kkal per 100 g × gram ÷ 100), lalu jumlahkan. Kesalahan paling sering adalah
  porsi TERLALU KECIL sehingga totalnya jauh di bawah target — kalau perkiraanmu
  masih kurang, besarkan porsinya atau tambah satu bahan lagi. Perkiraan ini
  hanya untuk kamu sendiri; jangan ditulis di jawaban.
- Bahasa Indonesia sehari-hari.
- DILARANG memberi klaim kesehatan, saran medis, atau janji hasil.`;

const STRICTER_SUFFIX = `

PERINGATAN: Percobaan sebelumnya ditolak. Periksa ulang: pakai hanya kode dari
daftar, gunakan porsi lazim yang disebutkan tiap kategori, dan susun agar total
kalorinya mendekati target. Jangan menulis angka apa pun selain "grams".`;

function buildPrompt(table: TkpiTable, req: MealRequest): string {
  const emphasis = req.isTrainingDay
    ? 'Hari ini hari latihan, jadi utamakan bahan berprotein.'
    : 'Hari ini hari istirahat.';

  const protein = req.proteinTargetG
    ? ` Target protein harian sekitar ${req.proteinTargetG} gram, dibagi ke tiga waktu makan.`
    : '';

  // Excluded rows are absent from the list entirely, so there is nothing for
  // the model to slip up about. Preferred ones are named, because that is a
  // preference and being overruled occasionally costs the user nothing.
  const prefer =
    req.preferCodes && req.preferCodes.length > 0
      ? `

Kalau cocok, dahulukan bahan ini karena biasanya ada di rumah: ${req.preferCodes.join(', ')}.`
      : '';

  return `Daftar bahan yang boleh dipakai:

${formatPantryForPrompt(table, req.excludeCodes ?? [])}

Waktu makan: ${SLOT_LABELS[req.slot]}
Target energi untuk waktu makan ini: sekitar ${req.budgetKcal} kkal
${emphasis}${protein}${prefer}

Buat tepat ${OPTIONS_PER_MEAL} opsi menu.`;
}

function isValidRequest(value: unknown): value is MealRequest {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<MealRequest>;
  return (
    SLOTS.includes(r.slot as Slot) &&
    typeof r.budgetKcal === 'number' &&
    Number.isFinite(r.budgetKcal) &&
    r.budgetKcal >= MIN_BUDGET_KCAL &&
    r.budgetKcal <= MAX_BUDGET_KCAL &&
    typeof r.isTrainingDay === 'boolean' &&
    (r.excludeCodes === undefined || Array.isArray(r.excludeCodes)) &&
    (r.preferCodes === undefined || Array.isArray(r.preferCodes))
  );
}

/**
 * Check the model's prose for figures it was told not to write.
 *
 * The totals are ours, so anything numeric in a note is by definition something
 * the model produced. Rather than reject the option, the note is dropped: the
 * menu itself is still valid, and losing one sentence costs the user less than
 * losing the suggestion.
 */
function stripUngroundedNotes(options: MealOption[], table: TkpiTable): MealOption[] {
  return options.map((option) => {
    if (!option.note) return option;

    const portions = option.items.map((item) => ({
      food: table.foods.find((f) => f.code === item.code)!,
      grams: item.grams,
    }));

    const verification = verifyGrounding(option.note, allowedValuesForPortions(portions));
    return verification.passed ? option : { ...option, note: undefined };
  });
}

/** Named export, not default — see the note in `coach.ts`. */
export { handler as POST };

async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Gunakan POST.' }, 405);

  const limited = await checkLimit(request, LIMITS.meals);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body bukan JSON yang sah.' }, 400);
  }

  if (!isValidRequest(body)) {
    return json(
      { error: `Butuh slot (pagi/siang/malam), budgetKcal ${MIN_BUDGET_KCAL}–${MAX_BUDGET_KCAL}, dan isTrainingDay.` },
      400,
    );
  }

  try {
    const table = await loadTable();
    const prompt = buildPrompt(table, body);

    let result = await completeJson<ModelOutput>({
      system: SYSTEM,
      user: prompt,
      schema: SCHEMA,
      schemaName: 'opsi_menu',
      maxTokens: 700,
    });

    // Validation uses the same filtered pantry the prompt did, so an excluded
    // code invented by the model is rejected rather than merely unlikely.
    const excluded = body.excludeCodes ?? [];
    let built = buildOptions(result.data.opsi ?? [], table, body.budgetKcal, excluded);
    let regenerated = false;

    if (built.options.length === 0) {
      // One retry. A second would spend latency and money re-asking a model
      // that has already failed the arithmetic constraint for this budget.
      regenerated = true;
      result = await completeJson<ModelOutput>({
        system: SYSTEM + STRICTER_SUFFIX,
        user: prompt,
        schema: SCHEMA,
        schemaName: 'opsi_menu',
        maxTokens: 700,
      });
      built = buildOptions(result.data.opsi ?? [], table, body.budgetKcal, excluded);
    }

    if (built.options.length === 0) {
      // Nothing survived. Saying so is the honest outcome — showing a menu
      // whose numbers we could not stand behind would be worse than showing
      // none.
      return json(
        {
          options: [],
          rejected: built.rejected,
          regenerated,
          message:
            'Belum berhasil menyusun menu yang totalnya mendekati target. Coba lagi, ' +
            'atau sesuaikan target kalorimu.',
        },
        200,
      );
    }

    return json({
      options: stripUngroundedNotes(built.options, table).slice(0, MAX_OPTIONS_SHOWN),
      rejected: built.rejected,
      regenerated,
      budgetKcal: body.budgetKcal,
      usage: result.usage,
      latencyMs: result.latencyMs,
    });
  } catch (error) {
    return errorResponse(error, 'Perencana menu sedang tidak bisa dihubungi.');
  }
}
