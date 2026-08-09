/**
 * What the coach may be asked between sets, and what it is allowed to do about
 * it.
 *
 * Two things happen during rest. Somebody asks what is coming next, which is a
 * question about a plan the device already knows. Or somebody says a joint
 * hurts, which is a request to change that plan — and changing a training plan
 * because of pain is the most consequential thing this product does with a
 * sentence of free text.
 *
 * ## Why the substitution is decided here and not by the model
 *
 * The same reason `directivesFor()` exists in the coach endpoint: the model is
 * good at reading "lutut kiriku sakit" out of a mumbled transcript and bad at
 * being the place a safety rule lives. So the model extracts *what hurts*, and
 * this table decides *what to do about it*. A model free to invent the
 * replacement could prescribe lunges — which load the same knee, and which the
 * camera cannot count either.
 *
 * ## Why the replacements are not `MovementKind`
 *
 * `MovementKind` is the set of movements the fast loop can judge, and
 * `types.ts` says plainly what widening it would cost: a meaningless entry in
 * every threshold table, every rule, every feature window. A glute bridge is
 * not something this app can count; pretending otherwise to fit it into an
 * existing type would put a number on screen that nothing measured.
 *
 * So substitutes are their own type, and every one of them carries
 * `tracked: false`. The screen says so, out loud. A product that claims to
 * watch you owes you the truth about the set it is not watching.
 *
 * Pure data and pure functions. No storage, no DOM, no clock.
 */

import { MOVEMENT_NAMES, type MovementKind } from './types.ts';

/** What the person said they came to say. */
export type RestIntent = 'question' | 'complaint' | 'other';

/**
 * Body parts a complaint can name.
 *
 * Closed, and deliberately coarse. The distinction that changes the plan is
 * "which movement loads this", and at that resolution a knee is a knee. Asking
 * a language model to distinguish a patellar tendon from a meniscus would be
 * inviting it to practise medicine.
 */
export type BodyPart = 'lutut' | 'bahu' | 'pergelangan-tangan' | 'punggung' | 'siku' | 'lainnya';

export const BODY_PARTS: readonly BodyPart[] = [
  'lutut',
  'bahu',
  'pergelangan-tangan',
  'punggung',
  'siku',
  'lainnya',
];

export type BodySide = 'kiri' | 'kanan' | 'keduanya';

export const BODY_SIDES: readonly BodySide[] = ['kiri', 'kanan', 'keduanya'];

/**
 * Movements the app may prescribe but cannot measure.
 *
 * Kept apart from `MovementKind` on purpose — see the note at the top of this
 * file. Nothing in the fast loop will ever be asked to count one of these.
 */
export type SubstituteMovement = 'glute-bridge' | 'wall-sit' | 'incline-pushup' | 'dead-bug';

export const SUBSTITUTE_NAMES: Record<SubstituteMovement, string> = {
  'glute-bridge': 'Glute bridge',
  'wall-sit': 'Wall sit',
  'incline-pushup': 'Push-up miring (tangan di kursi)',
  'dead-bug': 'Dead bug',
};

/** How the substitute is performed, since the camera will not be judging it. */
export const SUBSTITUTE_HOWTO: Record<SubstituteMovement, string> = {
  'glute-bridge':
    'Telentang, lutut ditekuk, telapak kaki menapak. Angkat pinggul sampai badan lurus dari bahu ke lutut, tahan sebentar, turunkan pelan.',
  'wall-sit':
    'Punggung menempel dinding, turun sampai paha sejajar lantai, lutut di atas mata kaki. Tahan.',
  'incline-pushup':
    'Tangan di kursi atau meja yang kokoh, badan lurus. Makin tinggi tumpuannya, makin ringan bebannya.',
  'dead-bug':
    'Telentang, lengan lurus ke atas, lutut di atas pinggul. Turunkan satu lengan dan kaki seberangnya, punggung bawah tetap menempel lantai.',
};

export interface Substitution {
  /** The movement being replaced. */
  from: MovementKind;
  to: SubstituteMovement;
  /** Always false today. Present so the UI never has to assume. */
  tracked: false;
  /** Shown to the user, and stored with the complaint. */
  reason: string;
}

/**
 * Which movement to avoid when a part hurts, and what to do instead.
 *
 * One entry per body part, and each names the movement it displaces. A part
 * that displaces nothing this app trains is absent, and the caller says so
 * rather than substituting something for the sake of having an answer.
 */
const SUBSTITUTIONS: Partial<Record<BodyPart, { from: MovementKind; to: SubstituteMovement }>> = {
  // The squat is the knee-loaded movement here. A glute bridge trains the same
  // hip extension lying down, with the knee angle held still.
  lutut: { from: 'squat', to: 'glute-bridge' },
  // Push-ups put the shoulder at its end range under load; raising the hands
  // shortens that range without removing the movement.
  bahu: { from: 'pushup', to: 'incline-pushup' },
  // Same movement, same reason: a raised grip takes most of the extension out
  // of the wrist.
  'pergelangan-tangan': { from: 'pushup', to: 'incline-pushup' },
  // A plank is a long lever on the lower back. A dead bug asks for the same
  // bracing with the spine supported by the floor.
  punggung: { from: 'plank', to: 'dead-bug' },
};

/**
 * The substitution for a complaint, or null when nothing in today's training
 * loads that part.
 *
 * Returning null matters as much as returning a substitution: an elbow
 * complaint has no entry, and inventing one would tell somebody their plan
 * changed when it did not.
 */
export function substitutionFor(part: BodyPart): Substitution | null {
  const rule = SUBSTITUTIONS[part];
  if (!rule) return null;

  return {
    from: rule.from,
    to: rule.to,
    tracked: false,
    reason: `Keluhan di ${part}`,
  };
}

/** "Squat diganti Glute bridge" — one phrasing, so every screen agrees. */
export function describeSubstitution(substitution: Substitution): string {
  return `${MOVEMENT_NAMES[substitution.from]} diganti ${SUBSTITUTE_NAMES[substitution.to]}`;
}

/* ------------------------------------------------------ model output shape */

/**
 * What the endpoint is allowed to return.
 *
 * The reply is prose and the model writes it. Everything that changes what the
 * user is asked to do is an enum, checked below before anything acts on it.
 */
export interface RestChatReply {
  intent: RestIntent;
  /** Present only for a complaint. */
  bodyPart: BodyPart | null;
  side: BodySide | null;
  /** Two sentences at most, written by the model. */
  answer: string;
  /** Decided in code from `bodyPart`, never by the model. */
  substitution: Substitution | null;
}

const INTENTS: readonly RestIntent[] = ['question', 'complaint', 'other'];

/**
 * Accept an answer from the network, or discard what cannot be trusted.
 *
 * This crosses HTTP, so its shape is somebody else's decision until it has
 * been through here — the same stance `sanitizeHistory` takes in
 * `nutritionChat.ts`.
 */
export function isRestChatReply(value: unknown): value is RestChatReply {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as Partial<RestChatReply>;

  if (!INTENTS.includes(reply.intent as RestIntent)) return false;
  if (typeof reply.answer !== 'string' || reply.answer.trim().length === 0) return false;
  if (reply.bodyPart !== null && !BODY_PARTS.includes(reply.bodyPart as BodyPart)) return false;
  if (reply.side !== null && !BODY_SIDES.includes(reply.side as BodySide)) return false;

  return true;
}

/**
 * What today still holds after this set.
 *
 * Answers "habis ini apa?" without a model: the split already decided, the
 * device already knows, and a question with a known answer should not cost a
 * network round trip to get wrong.
 */
export function remainingToday(
  movements: readonly MovementKind[],
  current: MovementKind,
): MovementKind[] {
  const index = movements.indexOf(current);
  return index === -1 ? [] : movements.slice(index + 1);
}

/** "Squat, lalu Plank" — or a sentence saying today is done. */
export function describeRemaining(remaining: readonly MovementKind[]): string {
  if (remaining.length === 0) return 'Ini gerakan terakhir hari ini.';
  const names = remaining.map((movement) => MOVEMENT_NAMES[movement]);
  return names.length === 1 ? `Habis ini ${names[0]}.` : `Habis ini ${names.join(', lalu ')}.`;
}

/** As long as one spoken or typed message can be. */
export const MAX_MESSAGE_CHARS = 300;
