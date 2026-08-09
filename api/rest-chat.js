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
  meals: { bucket: "meals", perHour: 30 },
  // Asked between sets, so several per set is normal — someone reporting pain
  // will often follow up, and a limit that cuts that conversation off mid-way
  // lands on the one exchange where being unhelpful matters most.
  restChat: { bucket: "rest-chat", perHour: 60 }
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

// web/src/core/types.ts
var MOVEMENT_NAMES = {
  pushup: "Push-up",
  squat: "Squat",
  plank: "Plank"
};
var HOLDS = ["plank"];
function isHold(movement) {
  return HOLDS.includes(movement);
}

// web/src/core/restChat.ts
var BODY_PARTS = [
  "lutut",
  "bahu",
  "pergelangan-tangan",
  "punggung",
  "siku",
  "lainnya"
];
var BODY_SIDES = ["kiri", "kanan", "keduanya"];
var SUBSTITUTE_NAMES = {
  "glute-bridge": "Glute bridge",
  "wall-sit": "Wall sit",
  "incline-pushup": "Push-up miring (tangan di kursi)",
  "dead-bug": "Dead bug"
};
var SUBSTITUTE_HOWTO = {
  "glute-bridge": "Telentang, lutut ditekuk, telapak kaki menapak. Angkat pinggul sampai badan lurus dari bahu ke lutut, tahan sebentar, turunkan pelan.",
  "wall-sit": "Punggung menempel dinding, turun sampai paha sejajar lantai, lutut di atas mata kaki. Tahan.",
  "incline-pushup": "Tangan di kursi atau meja yang kokoh, badan lurus. Makin tinggi tumpuannya, makin ringan bebannya.",
  "dead-bug": "Telentang, lengan lurus ke atas, lutut di atas pinggul. Turunkan satu lengan dan kaki seberangnya, punggung bawah tetap menempel lantai."
};
var SUBSTITUTIONS = {
  // The squat is the knee-loaded movement here. A glute bridge trains the same
  // hip extension lying down, with the knee angle held still.
  lutut: { from: "squat", to: "glute-bridge" },
  // Push-ups put the shoulder at its end range under load; raising the hands
  // shortens that range without removing the movement.
  bahu: { from: "pushup", to: "incline-pushup" },
  // Same movement, same reason: a raised grip takes most of the extension out
  // of the wrist.
  "pergelangan-tangan": { from: "pushup", to: "incline-pushup" },
  // A plank is a long lever on the lower back. A dead bug asks for the same
  // bracing with the spine supported by the floor.
  punggung: { from: "plank", to: "dead-bug" }
};
function substitutionFor(part) {
  const rule = SUBSTITUTIONS[part];
  if (!rule) return null;
  return {
    from: rule.from,
    to: rule.to,
    tracked: false,
    reason: `Keluhan di ${part}`
  };
}
function describeSubstitution(substitution) {
  return `${MOVEMENT_NAMES[substitution.from]} diganti ${SUBSTITUTE_NAMES[substitution.to]}`;
}
function describeRemaining(remaining) {
  if (remaining.length === 0) return "Ini gerakan terakhir hari ini.";
  const names = remaining.map((movement) => MOVEMENT_NAMES[movement]);
  return names.length === 1 ? `Habis ini ${names[0]}.` : `Habis ini ${names.join(", lalu ")}.`;
}
var MAX_MESSAGE_CHARS = 300;

// server/rest-chat.ts
var config = { runtime: "nodejs" };
var SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: ["question", "complaint", "other"],
      description: "complaint kalau menyebut nyeri, sakit, cedera, atau tidak kuat pada bagian tubuh. question kalau menanyakan sesuatu tentang latihan. other untuk sisanya."
    },
    bagian_tubuh: {
      type: "string",
      enum: [...BODY_PARTS, "tidak-ada"],
      description: 'Bagian tubuh yang dikeluhkan. "tidak-ada" kalau bukan keluhan.'
    },
    sisi: {
      type: "string",
      enum: [...BODY_SIDES, "tidak-ada"],
      description: 'Sisi yang dikeluhkan. "tidak-ada" kalau tidak disebut.'
    },
    jawaban: {
      type: "string",
      description: "Satu sampai dua kalimat, Bahasa Indonesia sehari-hari. JANGAN sebut gerakan pengganti apa pun \u2014 itu ditentukan di luar kamu."
    }
  },
  required: ["intent", "bagian_tubuh", "sisi", "jawaban"],
  additionalProperties: false
};
var SYSTEM = `Kamu pelatih kebugaran yang sedang mendampingi latihan. Penggunanya
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
- Kalau keluhannya terdengar serius \u2014 nyeri tajam, bengkak, tidak bisa menapak \u2014
  sarankan berhenti dan memeriksakan diri, tanpa menakut-nakuti.`;
function describeContext(request) {
  const remaining = request.today.slice(request.today.indexOf(request.movement) + 1);
  const unit = isHold(request.movement) ? "tahanan" : "repetisi";
  return `Gerakan yang baru selesai: ${MOVEMENT_NAMES[request.movement]} (diukur dalam ${unit})
Set selesai: ${request.setsDone} dari ${request.setsPlanned}
Sisa hari ini setelah gerakan ini: ${remaining.length === 0 ? "tidak ada, ini gerakan terakhir" : remaining.map((m) => MOVEMENT_NAMES[m]).join(", ")}

Yang dikatakan pengguna:
"${request.message}"`;
}
function isValidRequest(value) {
  if (typeof value !== "object" || value === null) return false;
  const body = value;
  return typeof body.message === "string" && body.message.trim().length > 0 && body.message.length <= MAX_MESSAGE_CHARS && typeof body.movement === "string" && body.movement in MOVEMENT_NAMES && Array.isArray(body.today) && body.today.every((m) => typeof m === "string" && m in MOVEMENT_NAMES) && typeof body.setsDone === "number" && typeof body.setsPlanned === "number";
}
async function handler(request) {
  if (request.method !== "POST") return json({ error: "Gunakan POST." }, 405);
  const limited = await checkLimit(request, LIMITS.restChat);
  if (limited) return limited;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body bukan JSON yang sah." }, 400);
  }
  if (!isValidRequest(body)) {
    return json({ error: `Butuh message (maksimal ${MAX_MESSAGE_CHARS} karakter) dan movement.` }, 400);
  }
  try {
    const result = await completeJson({
      system: SYSTEM,
      user: describeContext(body),
      schema: SCHEMA,
      schemaName: "jawaban_istirahat",
      maxTokens: 250
    });
    const part = result.data.bagian_tubuh === "tidak-ada" ? null : result.data.bagian_tubuh;
    const side = result.data.sisi === "tidak-ada" ? null : result.data.sisi;
    const substitution = result.data.intent === "complaint" && part ? substitutionFor(part) : null;
    const remaining = result.data.intent === "question" ? describeRemaining(body.today.slice(body.today.indexOf(body.movement) + 1)) : null;
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
      latencyMs: result.latencyMs
    });
  } catch (error) {
    return errorResponse(error, "Pelatih AI sedang tidak bisa dihubungi.");
  }
}
export {
  handler as POST,
  config
};
