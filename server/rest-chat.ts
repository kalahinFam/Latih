/**
 * The coach, answerable between sets.
 *
 * Two things get said during rest. "Habis ini apa?" — a question about a plan
 * the device already holds. And "lutut kiriku sakit" — a request to change that
 * plan, which is the most consequential thing this product does with a sentence
 * of free text.
 *
 * ## What the model decides, and what it does not
 *
 * It reads the sentence and returns *what hurts*: a body part from a closed
 * list, a side, an intent. It writes the reply, because that is prose.
 *
 * It does not choose the replacement exercise. That comes from the table in
 * `core/restChat.ts`, evaluated here, for the same reason `directivesFor()`
 * exists in `coach.ts`: a model free to pick would eventually answer a knee
 * complaint with lunges — which load the same knee, and which the camera cannot
 * count either. The comparison belongs in code; what the model contributes is
 * language.
 *
 * So the reply that reaches the user is assembled from both: the model's
 * sentence, then a line this endpoint writes itself naming the swap. The
 * consequential half is deterministic and reads the same every time.
 *
 * ## What crosses the network
 *
 * The sentence, the current movement, and what today still holds. Not the
 * complaint log — that is written on the device after this returns, and nothing
 * here ever sees the history of what has hurt before.
 */

import { completeJson, errorResponse, json } from './_llm.ts';
import { LIMITS, checkLimit } from './_ratelimit.ts';
import {
  BODY_PARTS,
  BODY_SIDES,
  MAX_MESSAGE_CHARS,
  SUBSTITUTE_HOWTO,
  SUBSTITUTE_NAMES,
  describeRemaining,
  describeSubstitution,
  substitutionFor,
  type BodyPart,
  type BodySide,
  type RestIntent,
} from '../web/src/core/restChat.ts';
import { MOVEMENT_NAMES, isHold, type MovementKind } from '../web/src/core/types.ts';

export const config = { runtime: 'nodejs' };

/** Named export, not default — see the note in `coach.ts`. */
export { handler as POST };

interface RestChatRequest {
  message: string;
  /** The movement just trained. */
  movement: MovementKind;
  /** Everything today asks for, in order. */
  today: MovementKind[];
  setsDone: number;
  setsPlanned: number;
}

interface ModelOutput {
  intent: RestIntent;
  bagian_tubuh: BodyPart | 'tidak-ada';
  sisi: BodySide | 'tidak-ada';
  jawaban: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: ['question', 'complaint', 'other'],
      description:
        'complaint kalau menyebut nyeri, sakit, cedera, atau tidak kuat pada bagian tubuh. ' +
        'question kalau menanyakan sesuatu tentang latihan. other untuk sisanya.',
    },
    bagian_tubuh: {
      type: 'string',
      enum: [...BODY_PARTS, 'tidak-ada'],
      description: 'Bagian tubuh yang dikeluhkan. "tidak-ada" kalau bukan keluhan.',
    },
    sisi: {
      type: 'string',
      enum: [...BODY_SIDES, 'tidak-ada'],
      description: 'Sisi yang dikeluhkan. "tidak-ada" kalau tidak disebut.',
    },
    jawaban: {
      type: 'string',
      description:
        'Satu sampai dua kalimat, Bahasa Indonesia sehari-hari. JANGAN sebut ' +
        'gerakan pengganti apa pun — itu ditentukan di luar kamu.',
    },
  },
  required: ['intent', 'bagian_tubuh', 'sisi', 'jawaban'],
  additionalProperties: false,
};

const SYSTEM = `Kamu pelatih kebugaran yang sedang mendampingi latihan. Penggunanya
baru selesai satu set dan sedang istirahat, lalu mengatakan sesuatu kepadamu.

Tugasmu dua: memahami maksudnya, lalu menjawab singkat seperti pelatih di sisi
lapangan.

Aturan:
- Bahasa Indonesia sehari-hari. Sapa dengan "kamu". Maksimal dua kalimat.
- Kalau dia mengeluh nyeri, tanggapi dengan tenang dan akui keluhannya. JANGAN
  mendiagnosis, JANGAN menyebut nama cedera, JANGAN menyuruh minum obat.
- DILARANG menyebut gerakan pengganti. Penggantinya ditentukan di luar kamu dan
  akan ditambahkan setelah jawabanmu. Menyebutnya sendiri berisiko menyarankan
  gerakan yang salah.
- Kalau dia bertanya tentang sisa latihan hari ini, jawab dari data "Sisa hari
  ini" yang diberikan. DILARANG mengarang gerakan yang tidak ada di sana.
- Kalau keluhannya terdengar serius — nyeri tajam, bengkak, tidak bisa menapak —
  sarankan berhenti dan memeriksakan diri, tanpa menakut-nakuti.`;

function describeContext(request: RestChatRequest): string {
  const remaining = request.today.slice(request.today.indexOf(request.movement) + 1);
  const unit = isHold(request.movement) ? 'tahanan' : 'repetisi';

  return `Gerakan yang baru selesai: ${MOVEMENT_NAMES[request.movement]} (diukur dalam ${unit})
Set selesai: ${request.setsDone} dari ${request.setsPlanned}
Sisa hari ini setelah gerakan ini: ${
    remaining.length === 0
      ? 'tidak ada, ini gerakan terakhir'
      : remaining.map((m) => MOVEMENT_NAMES[m]).join(', ')
  }

Yang dikatakan pengguna:
"${request.message}"`;
}

function isValidRequest(value: unknown): value is RestChatRequest {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Partial<RestChatRequest>;

  return (
    typeof body.message === 'string' &&
    body.message.trim().length > 0 &&
    body.message.length <= MAX_MESSAGE_CHARS &&
    typeof body.movement === 'string' &&
    body.movement in MOVEMENT_NAMES &&
    Array.isArray(body.today) &&
    body.today.every((m) => typeof m === 'string' && m in MOVEMENT_NAMES) &&
    typeof body.setsDone === 'number' &&
    typeof body.setsPlanned === 'number'
  );
}

async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Gunakan POST.' }, 405);

  const limited = await checkLimit(request, LIMITS.restChat);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body bukan JSON yang sah.' }, 400);
  }

  if (!isValidRequest(body)) {
    return json({ error: `Butuh message (maksimal ${MAX_MESSAGE_CHARS} karakter) dan movement.` }, 400);
  }

  try {
    const result = await completeJson<ModelOutput>({
      system: SYSTEM,
      user: describeContext(body),
      schema: SCHEMA,
      schemaName: 'jawaban_istirahat',
      maxTokens: 250,
    });

    const part = result.data.bagian_tubuh === 'tidak-ada' ? null : result.data.bagian_tubuh;
    const side = result.data.sisi === 'tidak-ada' ? null : result.data.sisi;

    // Decided here, from the table, never by the model.
    const substitution = result.data.intent === 'complaint' && part ? substitutionFor(part) : null;

    // A question about today's plan is answered from today's plan. If the
    // model wandered off it, this line is the one that is actually correct.
    const remaining =
      result.data.intent === 'question'
        ? describeRemaining(body.today.slice(body.today.indexOf(body.movement) + 1))
        : null;

    return json({
      intent: result.data.intent,
      bodyPart: part,
      side,
      answer: result.data.jawaban,
      substitution,
      // Sent alongside rather than folded into the prose, so the screen can
      // show the swap as a card the user can act on rather than a sentence
      // they have to parse.
      substitutionText: substitution ? describeSubstitution(substitution) : null,
      substituteName: substitution ? SUBSTITUTE_NAMES[substitution.to] : null,
      substituteHowto: substitution ? SUBSTITUTE_HOWTO[substitution.to] : null,
      remaining,
      usage: result.usage,
      latencyMs: result.latencyMs,
    });
  } catch (error) {
    return errorResponse(error, 'Pelatih AI sedang tidak bisa dihubungi.');
  }
}
