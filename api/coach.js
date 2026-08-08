// server/_llm.ts
import OpenAI from "openai";
var DEFAULT_MODEL = "gpt-4o-mini";
var PRICE_PER_MTOK = {
  input: Number(process.env.LLM_PRICE_INPUT_PER_MTOK ?? 0.15),
  output: Number(process.env.LLM_PRICE_OUTPUT_PER_MTOK ?? 0.6)
};
var client = null;
function getClient() {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY belum diset. Salin .env.example ke .env lalu isi kuncinya."
      );
    }
    client = new OpenAI({ apiKey });
  }
  return client;
}
function priceOf(promptTokens, completionTokens) {
  const usd = promptTokens / 1e6 * PRICE_PER_MTOK.input + completionTokens / 1e6 * PRICE_PER_MTOK.output;
  return Number(usd.toFixed(6));
}
async function completeJson(options) {
  const model = options.model ?? DEFAULT_MODEL;
  const startedAt = Date.now();
  const response = await getClient().chat.completions.create({
    model,
    max_completion_tokens: options.maxTokens ?? 400,
    messages: [
      { role: "system", content: options.system },
      { role: "user", content: options.user }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: options.schemaName,
        strict: true,
        schema: options.schema
      }
    }
  });
  const choice = response.choices[0];
  if (choice?.message?.refusal) {
    throw new Error(`Model menolak permintaan: ${choice.message.refusal}`);
  }
  const content = choice?.message?.content;
  if (!content) {
    const reason = choice?.finish_reason ?? "unknown";
    throw new Error(`Model tidak mengembalikan konten (finish_reason: ${reason}).`);
  }
  const promptTokens = response.usage?.prompt_tokens ?? 0;
  const completionTokens = response.usage?.completion_tokens ?? 0;
  return {
    data: JSON.parse(content),
    usage: {
      promptTokens,
      completionTokens,
      costUsd: priceOf(promptTokens, completionTokens)
    },
    latencyMs: Date.now() - startedAt,
    model
  };
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
function errorResponse(error, fallback) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[api]", message);
  const isConfig = message.includes("OPENAI_API_KEY");
  return json({ error: isConfig ? message : fallback }, isConfig ? 500 : 502);
}

// server/_ratelimit.ts
import { createHash } from "node:crypto";

// server/_redis.ts
function redisCommand() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return async (...args) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(args)
    });
    if (!response.ok) throw new Error(`Upstash ${response.status}`);
    return (await response.json()).result;
  };
}

// server/_ratelimit.ts
var LIMITS = {
  coach: { bucket: "coach", perHour: 30 },
  nutrition: { bucket: "nutrition", perHour: 30 },
  meals: { bucket: "meals", perHour: 30 }
};
var DAILY_QUOTA = Number(process.env.LLM_DAILY_QUOTA ?? 1500);
var memory = /* @__PURE__ */ new Map();
var memoryCounter = async (key, ttlSeconds) => {
  const now = Date.now();
  const existing = memory.get(key);
  if (!existing || existing.expiresAt <= now) {
    memory.set(key, { count: 1, expiresAt: now + ttlSeconds * 1e3 });
    return 1;
  }
  existing.count += 1;
  return existing.count;
};
function redisCounter(command) {
  return async (key, ttlSeconds) => {
    const count = Number(await command("INCR", key));
    if (count === 1) await command("EXPIRE", key, ttlSeconds);
    return count;
  };
}
function counterFor(command = redisCommand()) {
  return command ? redisCounter(command) : memoryCounter;
}
function clientKey(request) {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const ip = forwarded.split(",")[0]?.trim() || "unknown";
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}
function quotaDay(now = Date.now()) {
  return new Date(now + 7 * 60 * 60 * 1e3).toISOString().slice(0, 10);
}
function hourStamp(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 13);
}
function originAllowed(request) {
  const allowed = process.env.ALLOWED_ORIGIN;
  if (!allowed) return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return allowed.split(",").map((entry) => entry.trim()).filter(Boolean).includes(origin);
}
async function checkLimit(request, policy, deps = {}) {
  if (!originAllowed(request)) {
    return json({ error: "Permintaan ditolak." }, 403);
  }
  const count = deps.counter ?? counterFor();
  const now = deps.now ?? Date.now();
  const quota = deps.dailyQuota ?? DAILY_QUOTA;
  try {
    const hits = await count(
      `latih:rl:${policy.bucket}:${clientKey(request)}:${hourStamp(now)}`,
      3600
    );
    if (hits > policy.perHour) {
      return json(
        { error: "Terlalu banyak permintaan ke pelatih AI. Coba lagi beberapa menit lagi." },
        429
      );
    }
    const daily = await count(`latih:quota:${quotaDay(now)}`, 86400);
    if (daily > quota) {
      return json(
        {
          error: "Kuota harian pelatih AI sudah habis. Latihan tetap berjalan penuh \u2014 hitungan repetisi dan koreksi form tidak butuh jaringan."
        },
        429
      );
    }
  } catch (error) {
    console.error("[ratelimit]", error instanceof Error ? error.message : String(error));
  }
  return null;
}

// server/coach.ts
var config = { runtime: "nodejs" };
var SCHEMA = {
  type: "object",
  properties: {
    narasi: {
      type: "string",
      description: "Dua sampai tiga kalimat umpan balik untuk set ini, Bahasa Indonesia."
    },
    cue_utama: {
      type: "string",
      description: "Satu frasa koreksi singkat, maksimal enam kata."
    },
    fokus_set_berikutnya: {
      type: "string",
      description: "Satu hal konkret untuk diperbaiki di set berikutnya."
    }
  },
  required: ["narasi", "cue_utama", "fokus_set_berikutnya"],
  additionalProperties: false
};
var SYSTEM = `Kamu pelatih kebugaran berpengalaman yang sedang mendampingi latihan.

Kamu menerima statistik satu set yang baru selesai. Beri umpan balik seperti
pelatih di sisi lapangan: langsung, spesifik, dan menyemangati tanpa berlebihan.

Aturan:
- Bahasa Indonesia sehari-hari. Sapa dengan "kamu".
- Sebut angka hanya kalau membantu, dan bulatkan. "Turun sekitar setengah detik
  lebih lambat" lebih baik daripada "eccentricMs naik 480".
- Untuk plank, yang dinilai adalah berapa lama posisi benar-benar tertahan dan
  berapa kali garis badan putus \u2014 bukan berapa lama set berlangsung.
- Pilih SATU hal terpenting untuk dikoreksi. Menyebut tiga kesalahan sekaligus
  membuat tidak ada yang diperbaiki.
- Jangan pernah menyebut nama field, kode error mentah, atau istilah teknis
  seperti "eccentric" dan "landmark".
- Jangan memberi saran medis atau diagnosis cedera.
- Kalau ada bagian "Riwayat latihan", kaitkan umpan balikmu dengan perkembangan
  itu \u2014 misalnya menyebut perbaikan dibanding sesi sebelumnya, atau mengingatkan
  target yang sedang dikejar. Itu yang membedakan pelatih yang mengingat dari
  aplikasi yang hanya menghitung.
- Patuhi setiap baris yang diawali "INSTRUKSI:" pada data yang diberikan.
  Baris itu dihitung dari angka set ini, bukan tebakan.`;
var ERROR_LABELS = {
  shallow_depth: "kedalaman kurang",
  partial_lockout: "tidak diluruskan penuh di posisi atas",
  hip_sag: "pinggul turun",
  hip_pike: "pinggul terlalu naik",
  excessive_trunk_lean: "badan terlalu membungkuk ke depan"
};
var EXERCISE_LABELS = {
  pushup: "push-up",
  squat: "squat",
  plank: "plank"
};
function directivesFor(summary) {
  const directives = [];
  if (Object.keys(summary.errorCounts).length === 0) {
    directives.push(
      "INSTRUKSI: Tidak ada satu pun kesalahan terdeteksi di set ini, dan angka kedalaman serta konsistensinya sudah baik. DILARANG mengarang kekurangan atau menyuruh memperbaiki hal yang sudah benar. Akui hasilnya, lalu sarankan satu peningkatan untuk set berikutnya: tambah repetisi, perlambat fase turun, atau naik ke variasi yang lebih berat."
    );
  }
  const s = summary.session;
  if (s && s.sessions >= 2) {
    const regressed = s.repsDelta < 0 || s.depthDeltaDeg >= 3;
    const improved = s.repsDelta > 0 || s.depthDeltaDeg <= -3;
    if (regressed) {
      directives.push(
        "INSTRUKSI: Dibanding sesi sebelumnya, hasil sesi ini MENURUN. DILARANG mengatakan ada kemajuan, peningkatan, atau perkembangan. Akui penurunannya sekali dengan tenang tanpa menyalahkan, lalu arahkan ke satu hal yang bisa diperbaiki."
      );
    } else if (improved) {
      directives.push(
        "INSTRUKSI: Dibanding sesi sebelumnya, hasil sesi ini MEMBAIK. Akui itu."
      );
    }
    directives.push(
      'INSTRUKSI: Sebutkan perubahan antar-sesi hanya sebagai selisih apa adanya (misalnya "dua repetisi lebih banyak"). DILARANG menyatakannya sebagai kelipatan atau persentase \u2014 angka itu tidak diberikan kepadamu.'
    );
  }
  if (summary.trackingQuality < 0.8) {
    directives.push(
      `INSTRUKSI: Kamera hanya membaca ${(summary.trackingQuality * 100).toFixed(0)}% gerakan. WAJIB sebutkan dalam satu anak kalimat bahwa sebagian gerakan kurang terbaca sehingga penilaian ini mungkin tidak lengkap, dan sarankan memperbaiki posisi kamera.`
    );
  }
  return directives;
}
function describeSet(summary) {
  const errors = Object.entries(summary.errorCounts).map(([code, count]) => `- ${ERROR_LABELS[code] ?? code}: ${count} dari ${summary.repCount} rep`).join("\n");
  const tempo = summary.tempo.tempoDriftMs;
  const drift = Math.abs(tempo) < 150 ? "Tempo turun stabil sepanjang set." : tempo > 0 ? `Fase turun melambat sekitar ${Math.round(tempo)} ms di paruh kedua set (tanda kelelahan).` : `Fase turun justru mengalami percepatan sekitar ${Math.abs(Math.round(tempo))} ms di paruh kedua.`;
  return `Gerakan: ${EXERCISE_LABELS[summary.exercise] ?? summary.exercise}
Jumlah repetisi: ${summary.repCount}
Durasi set: ${(summary.durationMs / 1e3).toFixed(0)} detik

Kedalaman (sudut sendi utama di titik terendah; makin kecil makin dalam):
- rata-rata ${summary.depth.meanDeg}\xB0, terbaik ${summary.depth.bestDeg}\xB0, terdangkal ${summary.depth.worstDeg}\xB0
- konsistensi antar-rep: ${summary.depth.consistencyDeg}\xB0 simpangan baku

Tempo:
- turun rata-rata ${summary.tempo.meanEccentricMs} ms, naik rata-rata ${summary.tempo.meanConcentricMs} ms
- ${drift}

Kesalahan terdeteksi:
${errors || "- tidak ada"}

Kualitas pembacaan kamera: ${(summary.trackingQuality * 100).toFixed(0)}%${describeSession(summary)}${directivesFor(summary).length > 0 ? `

${directivesFor(summary).join("\n\n")}` : ""}`;
}
function describeHold(summary) {
  const hold = summary.hold;
  const held = Math.round(hold.heldMs / 1e3);
  const broken = Math.round(hold.brokenMs / 1e3);
  const faults = Object.entries(summary.errorCounts).map(([code, count]) => `- ${ERROR_LABELS[code] ?? code}: ${count}\xD7`).join("\n");
  const directives = [];
  if (hold.breaks === 0) {
    directives.push(
      "INSTRUKSI: Garis badan tidak pernah putus sepanjang set ini. DILARANG mengarang kekurangan. Akui hasilnya, lalu sarankan satu peningkatan untuk set berikutnya: tahan lebih lama, atau tambah satu set."
    );
  }
  if (summary.trackingQuality < 0.8) {
    directives.push(
      `INSTRUKSI: Kamera hanya membaca ${(summary.trackingQuality * 100).toFixed(0)}% gerakan. WAJIB sebutkan dalam satu anak kalimat bahwa sebagian gerakan kurang terbaca, dan sarankan memperbaiki posisi kamera.`
    );
  }
  return `Gerakan: plank
Durasi tertahan: ${held} detik
Waktu terbuang karena garis badan putus: ${broken} detik
Berapa kali hitungan berhenti: ${hold.breaks}

Kesalahan terdeteksi:
${faults || "- tidak ada"}

Kualitas pembacaan kamera: ${(summary.trackingQuality * 100).toFixed(0)}%${describeSession(summary)}${directives.length > 0 ? `

${directives.join("\n\n")}` : ""}`;
}
function describeSession(summary) {
  const s = summary.session;
  if (!s) return "";
  const lines = [`Target set ini: ${s.targetReps} repetisi (${s.targetReason})`];
  if (s.sessions >= 2) {
    lines.push(
      s.repsDelta === 0 ? "Jumlah repetisi sama dengan sesi sebelumnya." : `Repetisi ${s.repsDelta > 0 ? "naik" : "turun"} ${Math.abs(s.repsDelta)} dibanding sesi sebelumnya.`
    );
    if (Math.abs(s.depthDeltaDeg) >= 3) {
      lines.push(
        s.depthDeltaDeg < 0 ? `Kedalaman membaik sekitar ${Math.abs(s.depthDeltaDeg).toFixed(0)} derajat.` : `Kedalaman berkurang sekitar ${s.depthDeltaDeg.toFixed(0)} derajat.`
      );
    }
  }
  return `

Riwayat latihan (sesi ke-${s.sessions}):
${lines.map((l) => `- ${l}`).join("\n")}`;
}
function containsPoseData(raw) {
  return /landmark|"frames"|base64|data:image/i.test(raw);
}
function isValidSummary(value) {
  if (typeof value !== "object" || value === null) return false;
  const s = value;
  return (s.exercise === "pushup" || s.exercise === "squat" || s.exercise === "plank") && typeof s.repCount === "number" && Array.isArray(s.reps) && typeof s.depth === "object" && typeof s.tempo === "object";
}
async function handler(request) {
  if (request.method !== "POST") {
    return json({ error: "Gunakan POST." }, 405);
  }
  const limited = await checkLimit(request, LIMITS.coach);
  if (limited) return limited;
  let raw;
  try {
    raw = await request.text();
  } catch {
    return json({ error: "Body tidak terbaca." }, 400);
  }
  if (containsPoseData(raw)) {
    return json({ error: "Payload berisi data pose mentah; ditolak." }, 400);
  }
  let summary;
  try {
    summary = JSON.parse(raw);
  } catch {
    return json({ error: "Body bukan JSON yang sah." }, 400);
  }
  if (!isValidSummary(summary)) {
    return json({ error: "Ringkasan set tidak lengkap." }, 400);
  }
  if (summary.hold) {
    try {
      const result = await completeJson({
        system: SYSTEM,
        user: describeHold(summary),
        schema: SCHEMA,
        schemaName: "umpan_balik_set",
        maxTokens: 400
      });
      return json({ ...result.data, usage: result.usage, latencyMs: result.latencyMs });
    } catch (error) {
      return errorResponse(error, "Pelatih AI sedang tidak bisa dihubungi.");
    }
  }
  if (summary.repCount === 0) {
    return json({
      narasi: "Belum ada repetisi yang terhitung di set ini. Coba periksa posisi kamera.",
      cue_utama: "Periksa posisi kamera",
      fokus_set_berikutnya: "Pastikan seluruh badan terlihat sebelum mulai.",
      usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
      latencyMs: 0
    });
  }
  try {
    const result = await completeJson({
      system: SYSTEM,
      user: describeSet(summary),
      schema: SCHEMA,
      schemaName: "umpan_balik_set",
      maxTokens: 400
    });
    return json({ ...result.data, usage: result.usage, latencyMs: result.latencyMs });
  } catch (error) {
    return errorResponse(error, "Pelatih AI sedang tidak bisa dihubungi.");
  }
}
export {
  config,
  handler as default
};
