/**
 * Slow loop — narrative coaching, once per completed set.
 *
 * ## What crosses the network, and what cannot
 *
 * The request body is the set summary and nothing else: counts, joint angles in
 * degrees, durations, error codes. No frames, no landmark coordinates. That is
 * the privacy claim, and it is enforced on both sides — the client builds the
 * payload from a type with no field able to hold image data, and this endpoint
 * rejects anything carrying pose data before it reaches the model.
 *
 * ## Why this is a different loop, not a bigger rule
 *
 * The fast loop can say "turunkan dada lebih dalam" while a rep is happening.
 * What it cannot do is look across a whole set and notice the descent slowed by
 * 400 ms between the first half and the second, then decide that matters more
 * than depth this time. That judgement over aggregate context is what the model
 * is here for, and why the numbers below are set-level statistics rather than
 * per-frame data.
 */

import { completeJson, errorResponse, json } from './_llm.ts';

export const config = { runtime: 'nodejs' };

/** Mirrors `SetSummary` in web/src/core/setSummary.ts. */
interface SetSummaryPayload {
  exercise: 'pushup' | 'squat';
  repCount: number;
  durationMs: number;
  reps: {
    index: number;
    minAngle: number;
    maxAngle: number;
    eccentricMs: number;
    concentricMs: number;
    errors: string[];
  }[];
  errorCounts: Record<string, number>;
  depth: { meanDeg: number; bestDeg: number; worstDeg: number; consistencyDeg: number };
  tempo: { meanEccentricMs: number; meanConcentricMs: number; tempoDriftMs: number };
  trackingQuality: number;
}

interface CoachOutput {
  narasi: string;
  cue_utama: string;
  fokus_set_berikutnya: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    narasi: {
      type: 'string',
      description: 'Dua sampai tiga kalimat umpan balik untuk set ini, Bahasa Indonesia.',
    },
    cue_utama: {
      type: 'string',
      description: 'Satu frasa koreksi singkat, maksimal enam kata.',
    },
    fokus_set_berikutnya: {
      type: 'string',
      description: 'Satu hal konkret untuk diperbaiki di set berikutnya.',
    },
  },
  required: ['narasi', 'cue_utama', 'fokus_set_berikutnya'],
  additionalProperties: false,
};

const SYSTEM = `Kamu pelatih kebugaran berpengalaman yang sedang mendampingi latihan.

Kamu menerima statistik satu set yang baru selesai. Beri umpan balik seperti
pelatih di sisi lapangan: langsung, spesifik, dan menyemangati tanpa berlebihan.

Aturan:
- Bahasa Indonesia sehari-hari. Sapa dengan "kamu".
- Sebut angka hanya kalau membantu, dan bulatkan. "Turun sekitar setengah detik
  lebih lambat" lebih baik daripada "eccentricMs naik 480".
- Pilih SATU hal terpenting untuk dikoreksi. Menyebut tiga kesalahan sekaligus
  membuat tidak ada yang diperbaiki.
- Jangan pernah menyebut nama field, kode error mentah, atau istilah teknis
  seperti "eccentric" dan "landmark".
- Jangan memberi saran medis atau diagnosis cedera.
- Patuhi setiap baris yang diawali "INSTRUKSI:" pada data yang diberikan.
  Baris itu dihitung dari angka set ini, bukan tebakan.`;

/** Human-readable names, so the model never sees a raw code to echo back. */
const ERROR_LABELS: Record<string, string> = {
  shallow_depth: 'kedalaman kurang',
  partial_lockout: 'tidak diluruskan penuh di posisi atas',
  hip_sag: 'pinggul turun',
  hip_pike: 'pinggul terlalu naik',
  excessive_trunk_lean: 'badan terlalu membungkuk ke depan',
};

const EXERCISE_LABELS: Record<string, string> = {
  pushup: 'push-up',
  squat: 'squat',
};

/**
 * Conditions evaluated in code, handed to the model as direct instructions.
 *
 * Testing against real sets showed the model would not reliably apply rules of
 * the form "if trackingQuality is below 0.8, mention it" — it compared the
 * number and then simply did not act on it. Worse, on a set with no detected
 * faults it manufactured one, coaching a lifter to fix depth that was already
 * excellent.
 *
 * Both are the same mistake on my side: asking a language model to evaluate a
 * numeric threshold and remember a conditional. The comparison belongs in code;
 * what reaches the model is an unconditional instruction it only has to follow.
 */
function directivesFor(summary: SetSummaryPayload): string[] {
  const directives: string[] = [];

  if (Object.keys(summary.errorCounts).length === 0) {
    directives.push(
      'INSTRUKSI: Tidak ada satu pun kesalahan terdeteksi di set ini, dan angka ' +
        'kedalaman serta konsistensinya sudah baik. DILARANG mengarang kekurangan ' +
        'atau menyuruh memperbaiki hal yang sudah benar. Akui hasilnya, lalu ' +
        'sarankan satu peningkatan untuk set berikutnya: tambah repetisi, ' +
        'perlambat fase turun, atau naik ke variasi yang lebih berat.',
    );
  }

  if (summary.trackingQuality < 0.8) {
    directives.push(
      `INSTRUKSI: Kamera hanya membaca ${(summary.trackingQuality * 100).toFixed(0)}% gerakan. ` +
        'WAJIB sebutkan dalam satu anak kalimat bahwa sebagian gerakan kurang ' +
        'terbaca sehingga penilaian ini mungkin tidak lengkap, dan sarankan ' +
        'memperbaiki posisi kamera.',
    );
  }

  return directives;
}

function describeSet(summary: SetSummaryPayload): string {
  const errors = Object.entries(summary.errorCounts)
    .map(([code, count]) => `- ${ERROR_LABELS[code] ?? code}: ${count} dari ${summary.repCount} rep`)
    .join('\n');

  const tempo = summary.tempo.tempoDriftMs;
  const drift =
    Math.abs(tempo) < 150
      ? 'Tempo turun stabil sepanjang set.'
      : tempo > 0
        ? `Fase turun melambat sekitar ${Math.round(tempo)} ms di paruh kedua set (tanda kelelahan).`
        : `Fase turun justru mengalami percepatan sekitar ${Math.abs(Math.round(tempo))} ms di paruh kedua.`;

  return `Gerakan: ${EXERCISE_LABELS[summary.exercise] ?? summary.exercise}
Jumlah repetisi: ${summary.repCount}
Durasi set: ${(summary.durationMs / 1000).toFixed(0)} detik

Kedalaman (sudut sendi utama di titik terendah; makin kecil makin dalam):
- rata-rata ${summary.depth.meanDeg}°, terbaik ${summary.depth.bestDeg}°, terdangkal ${summary.depth.worstDeg}°
- konsistensi antar-rep: ${summary.depth.consistencyDeg}° simpangan baku

Tempo:
- turun rata-rata ${summary.tempo.meanEccentricMs} ms, naik rata-rata ${summary.tempo.meanConcentricMs} ms
- ${drift}

Kesalahan terdeteksi:
${errors || '- tidak ada'}

Kualitas pembacaan kamera: ${(summary.trackingQuality * 100).toFixed(0)}%${
    directivesFor(summary).length > 0 ? `\n\n${directivesFor(summary).join('\n\n')}` : ''
  }`;
}

/** Reject a payload carrying anything image-shaped, before it reaches the model. */
function containsPoseData(raw: string): boolean {
  return /landmark|"frames"|base64|data:image/i.test(raw);
}

function isValidSummary(value: unknown): value is SetSummaryPayload {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<SetSummaryPayload>;
  return (
    (s.exercise === 'pushup' || s.exercise === 'squat') &&
    typeof s.repCount === 'number' &&
    Array.isArray(s.reps) &&
    typeof s.depth === 'object' &&
    typeof s.tempo === 'object'
  );
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Gunakan POST.' }, 405);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json({ error: 'Body tidak terbaca.' }, 400);
  }

  if (containsPoseData(raw)) {
    // Defence in depth. The client cannot construct such a payload from
    // `SetSummary`, so reaching here means something upstream changed and the
    // privacy guarantee needs re-examining — not quietly forwarding.
    return json({ error: 'Payload berisi data pose mentah; ditolak.' }, 400);
  }

  let summary: unknown;
  try {
    summary = JSON.parse(raw);
  } catch {
    return json({ error: 'Body bukan JSON yang sah.' }, 400);
  }

  if (!isValidSummary(summary)) {
    return json({ error: 'Ringkasan set tidak lengkap.' }, 400);
  }

  if (summary.repCount === 0) {
    // No model call: there is nothing to coach, and spending a request plus a
    // second of latency to say so would be worse than answering directly.
    return json({
      narasi: 'Belum ada repetisi yang terhitung di set ini. Coba periksa posisi kamera.',
      cue_utama: 'Periksa posisi kamera',
      fokus_set_berikutnya: 'Pastikan seluruh badan terlihat sebelum mulai.',
      usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
      latencyMs: 0,
    });
  }

  try {
    const result = await completeJson<CoachOutput>({
      system: SYSTEM,
      user: describeSet(summary),
      schema: SCHEMA,
      schemaName: 'umpan_balik_set',
      maxTokens: 400,
    });

    // Usage is returned to the client so the latency and operating-cost tables
    // in the paper come from real traffic rather than an estimate.
    return json({ ...result.data, usage: result.usage, latencyMs: result.latencyMs });
  } catch (error) {
    return errorResponse(error, 'Pelatih AI sedang tidak bisa dihubungi.');
  }
}
