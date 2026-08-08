// server/nutrition.ts
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// web/src/core/grounding.ts
var UNIT_PATTERN = "kkal|kilokalori|kalori|kal|mg|miligram|gram|gr|g";
var CLAIM_RE = new RegExp(String.raw`(\d[\d.,]*)\s*(${UNIT_PATTERN})\b(?![a-z])`, "gi");
function parseIndonesianNumber(raw) {
  const cleaned = raw.trim();
  if (!/^\d[\d.,]*$/.test(cleaned)) return null;
  const hasComma = cleaned.includes(",");
  let normalized;
  if (hasComma) {
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
    normalized = cleaned.replace(/\./g, "");
  } else {
    normalized = cleaned;
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}
function normalizeUnit(unit) {
  const u = unit.toLowerCase();
  if (u === "kkal" || u === "kilokalori" || u === "kalori" || u === "kal") return "kcal";
  if (u === "mg" || u === "miligram") return "g";
  if (u === "g" || u === "gr" || u === "gram") return "g";
  return null;
}
function extractClaims(text) {
  const claims = [];
  for (const match of text.matchAll(CLAIM_RE)) {
    const value = parseIndonesianNumber(match[1]);
    const family = normalizeUnit(match[2]);
    if (value === null || family === null) continue;
    const isMilligram = /^m/i.test(match[2]);
    claims.push({
      raw: match[1],
      value,
      unit: match[2].toLowerCase(),
      normalized: isMilligram ? value / 1e3 : value
    });
  }
  return claims;
}
function matches(claim, allowed) {
  return Math.abs(claim - allowed) <= Math.max(0.5, Math.abs(allowed) * 0.01);
}
function verifyGrounding(answer, allowedValues, questionValues = []) {
  const claims = extractClaims(answer);
  const allowed = [...allowedValues, ...questionValues];
  const unmatched = claims.filter((claim) => !allowed.some((value) => matches(claim.normalized, value)));
  return {
    passed: unmatched.length === 0,
    claims,
    unmatched,
    // No claims means nothing was asserted, which is grounded by default —
    // an answer that cites no figures cannot cite a wrong one.
    groundedRatio: claims.length === 0 ? 1 : (claims.length - unmatched.length) / claims.length
  };
}
function numbersInQuestion(question) {
  const values = [];
  for (const match of question.matchAll(/\d[\d.,]*/g)) {
    const value = parseIndonesianNumber(match[0]);
    if (value !== null) values.push(value);
  }
  return values;
}

// web/src/core/nutritionChat.ts
var MAX_QUESTION_CHARS = 300;
var MAX_HISTORY_TURNS = 6;
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function sanitizeHistory(value) {
  if (!Array.isArray(value)) return [];
  const turns = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const turn = entry;
    if (turn.role !== "user" && turn.role !== "assistant") continue;
    if (typeof turn.content !== "string") continue;
    const content = turn.content.trim().slice(0, MAX_QUESTION_CHARS);
    if (content.length === 0) continue;
    turns.push({ role: turn.role, content });
  }
  return turns.slice(-MAX_HISTORY_TURNS);
}
function lastUserMessage(history) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === "user") return history[i].content;
  }
  return null;
}
function isChatContext(value) {
  if (value === void 0 || value === null) return true;
  if (typeof value !== "object") return false;
  const context = value;
  return (context.targetKcal === void 0 || isFiniteNumber(context.targetKcal)) && (context.proteinG === void 0 || isFiniteNumber(context.proteinG)) && (context.isTrainingDay === void 0 || typeof context.isTrainingDay === "boolean");
}
function contextValues(context) {
  if (!context) return [];
  const values = [];
  if (isFiniteNumber(context.targetKcal)) values.push(context.targetKcal);
  if (isFiniteNumber(context.proteinG)) values.push(context.proteinG);
  return values;
}
function formatContextForPrompt(context) {
  if (!context) return "";
  const parts = [];
  if (isFiniteNumber(context.targetKcal)) {
    parts.push(`target energi harian ${Math.round(context.targetKcal)} kkal`);
  }
  if (isFiniteNumber(context.proteinG)) {
    parts.push(`target protein harian ${Math.round(context.proteinG)} gram`);
  }
  if (context.isTrainingDay !== void 0) {
    parts.push(context.isTrainingDay ? "hari ini hari latihan" : "hari ini hari istirahat");
  }
  return parts.length === 0 ? "" : `Data pengguna (dihitung di perangkatnya): ${parts.join(", ")}.`;
}
function formatTranscript(history) {
  if (history.length === 0) return "";
  return history.map((turn) => `${turn.role === "user" ? "Pengguna" : "Asisten"}: ${turn.content}`).join("\n");
}

// web/src/core/tkpi.ts
function normalizeName(text) {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
var STOPWORDS = /* @__PURE__ */ new Set([
  "berapa",
  "kandungan",
  "gizi",
  "nutrisi",
  "kalori",
  "protein",
  "lemak",
  "karbohidrat",
  "serat",
  "dalam",
  "pada",
  "untuk",
  "dan",
  "atau",
  "yang",
  "per",
  "gram",
  "g",
  "kkal",
  "apa",
  "itu",
  "saja",
  "dari",
  "ada",
  "di",
  "makan",
  "makanan",
  "porsi",
  "butir",
  "buah",
  "potong"
]);
function tokenize(text) {
  return normalizeName(text).split(" ").filter((word) => word.length > 1 && !STOPWORDS.has(word) && !/^\d+$/.test(word));
}
var MAX_COMMON_TOKEN_SHARE = 0.03;
var ALWAYS_DISTINCTIVE_BELOW = 3;
var frequencyCache = /* @__PURE__ */ new WeakMap();
function documentFrequency(table) {
  const cached2 = frequencyCache.get(table);
  if (cached2) return cached2;
  const counts = /* @__PURE__ */ new Map();
  for (const food of table.foods) {
    const seen = new Set(tokenize([food.name, ...food.aliases ?? []].join(" ")));
    for (const token of seen) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  frequencyCache.set(table, counts);
  return counts;
}
function isDistinctive(token, frequency, total) {
  const count = frequency.get(token) ?? 0;
  if (count === 0) return false;
  return count <= Math.max(ALWAYS_DISTINCTIVE_BELOW, total * MAX_COMMON_TOKEN_SHARE);
}
function scoreFood(food, queryTokens, frequency, total) {
  const names = [food.name, ...food.aliases ?? []];
  let best = { score: 0, distinctive: false };
  for (const name of names) {
    const nameTokens = tokenize(name);
    if (nameTokens.length === 0) continue;
    let score = 0;
    let distinctive = false;
    for (const query of queryTokens) {
      const exact = nameTokens.includes(query);
      const prefix = !exact && nameTokens.some((token) => token.startsWith(query) && query.length >= 4);
      if (!exact && !prefix) continue;
      score += exact ? 1 : 0.5;
      if (isDistinctive(query, frequency, total)) distinctive = true;
    }
    if (score > 0) {
      const normalized = score / Math.sqrt(nameTokens.length);
      if (normalized > best.score) best = { score: normalized, distinctive };
    }
  }
  return best;
}
function findFoods(table, question, limit = 4) {
  const queryTokens = tokenize(question);
  if (queryTokens.length === 0) return [];
  const frequency = documentFrequency(table);
  const total = table.foods.length;
  return table.foods.filter((food) => !food.suspect).map((food) => ({ food, ...scoreFood(food, queryTokens, frequency, total) })).filter((match) => match.score > 0 && match.distinctive).sort((a, b) => b.score - a.score).slice(0, limit);
}
var COMPARISON_SPLIT = /\batau\b|\bvs\.?\b|\bdibandingkan?\b|\bdibanding\b/i;
function findFoodsForQuestion(table, question, limit = 4, perSide = 2) {
  const sides = question.split(COMPARISON_SPLIT).map((side) => side.trim()).filter((side) => side.length > 0);
  if (sides.length < 2) return findFoods(table, question, limit).map((match) => match.food);
  const perSideMatches = sides.map((side) => findFoods(table, side, perSide).map((m) => m.food));
  const foods = [];
  const seen = /* @__PURE__ */ new Set();
  for (let rank = 0; rank < perSide; rank += 1) {
    for (const matches2 of perSideMatches) {
      const food = matches2[rank];
      if (!food || seen.has(food.code)) continue;
      seen.add(food.code);
      foods.push(food);
      if (foods.length === limit) return foods;
    }
  }
  return foods;
}
function allowedValuesFor(foods) {
  const values = [];
  for (const food of foods) {
    values.push(food.basisG, food.energyKcal, food.proteinG, food.fatG, food.carbG);
    if (food.fiberG !== void 0) values.push(food.fiberG);
  }
  return values;
}
function formatForPrompt(foods) {
  return foods.map(
    (food) => `${food.name} (kode ${food.code}), per ${food.basisG} gram:
  energi ${food.energyKcal} kkal
  protein ${food.proteinG} gram
  lemak ${food.fatG} gram
  karbohidrat ${food.carbG} gram` + (food.fiberG !== void 0 ? `
  serat ${food.fiberG} gram` : "")
  ).join("\n\n");
}
function hasUnverified(foods) {
  return foods.some((food) => !food.verified);
}

// server/nutrition.ts
var config = { runtime: "nodejs" };
var DATA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "tkpi",
  "tkpi.json"
);
var cached = null;
async function loadTable() {
  if (!cached) cached = JSON.parse(await readFile(DATA_PATH, "utf8"));
  return cached;
}
var SCHEMA = {
  type: "object",
  properties: {
    jawaban: {
      type: "string",
      description: "Jawaban ringkas dalam Bahasa Indonesia, maksimal tiga kalimat."
    }
  },
  required: ["jawaban"],
  additionalProperties: false
};
var SYSTEM = `Kamu asisten gizi yang menjawab berdasarkan Tabel Komposisi Pangan
Indonesia (TKPI).

ATURAN MUTLAK:
- Setiap angka yang kamu tulis HARUS berasal persis dari data yang diberikan,
  termasuk angka target harian pengguna kalau memang disertakan.
- DILARANG menghitung, menjumlahkan, mengalikan, atau memperkirakan angka baru.
  Kalau pengguna bertanya untuk 150 gram sedangkan data per 100 gram, katakan
  angkanya per 100 gram dan jelaskan bahwa itu basis datanya \u2014 jangan dikalikan.
- DILARANG memakai angka dari pengetahuanmu sendiri. Kalau data tidak memuat
  yang ditanyakan, katakan datanya tidak tersedia.
- Ini percakapan: kalau pertanyaan terakhir merujuk ke bahan yang dibahas
  sebelumnya, jawab tentang bahan itu. Jangan mengulang jawaban sebelumnya.
- Bahasa Indonesia sehari-hari, maksimal tiga kalimat.
- Jangan memberi saran medis atau klaim kesehatan.`;
var STRICTER_SUFFIX = `

PERINGATAN: Jawaban sebelumnya memuat angka yang TIDAK ada di data. Tulis ulang
dan gunakan HANYA angka yang tertulis persis di data di bawah. Kalau ragu,
sebutkan lebih sedikit angka.`;
function buildPrompt(question, foods, history, context) {
  const parts = [`Data TKPI yang tersedia:

${formatForPrompt(foods)}`];
  const plan = formatContextForPrompt(context);
  if (plan) parts.push(plan);
  if (history.length > 0) parts.push(`Percakapan sebelumnya:
${formatTranscript(history)}`);
  parts.push(`Pertanyaan pengguna: ${question}`);
  return parts.join("\n\n");
}
function toCitations(foods) {
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
    verified: food.verified
  }));
}
async function handler(request) {
  if (request.method !== "POST") return json({ error: "Gunakan POST." }, 405);
  const limited = await checkLimit(request, LIMITS.nutrition);
  if (limited) return limited;
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Body bukan JSON yang sah." }, 400);
  }
  const { question } = payload;
  if (typeof question !== "string" || question.trim().length === 0) {
    return json({ error: 'Field "question" wajib diisi.' }, 400);
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return json({ error: `Pertanyaan maksimal ${MAX_QUESTION_CHARS} karakter.` }, 413);
  }
  if (!isChatContext(payload.context)) {
    return json({ error: 'Field "context" tidak valid.' }, 400);
  }
  const history = sanitizeHistory(payload.history);
  const context = payload.context;
  try {
    const table = await loadTable();
    let foods = findFoodsForQuestion(table, question);
    const previous = lastUserMessage(history);
    if (foods.length === 0 && previous) {
      foods = findFoodsForQuestion(table, `${previous} ${question}`);
    }
    if (foods.length === 0) {
      return json({
        answer: "Bahan pangan itu belum ada di data TKPI yang tersedia. Coba sebutkan nama bahan yang lebih umum, misalnya tempe, tahu, telur, atau nasi.",
        citations: [],
        verification: { passed: true, checked: 0, unmatched: [], regenerated: false },
        dataWarning: null
      });
    }
    const allowed = [...allowedValuesFor(foods), ...contextValues(context)];
    const questionValues = numbersInQuestion(question);
    const prompt = buildPrompt(question, foods, history, context);
    let result = await completeJson({
      system: SYSTEM,
      user: prompt,
      schema: SCHEMA,
      schemaName: "jawaban_gizi",
      maxTokens: 300
    });
    let verification = verifyGrounding(result.data.jawaban, allowed, questionValues);
    let regenerated = false;
    if (!verification.passed) {
      regenerated = true;
      result = await completeJson({
        system: SYSTEM + STRICTER_SUFFIX,
        user: prompt,
        schema: SCHEMA,
        schemaName: "jawaban_gizi",
        maxTokens: 300
      });
      verification = verifyGrounding(result.data.jawaban, allowed, questionValues);
    }
    const citations = toCitations(foods);
    const dataWarning = hasUnverified(foods) ? "Sebagian data belum diverifikasi terhadap TKPI resmi." : null;
    if (!verification.passed) {
      return json({
        answer: "Jawaban otomatis tidak lolos pemeriksaan angka, jadi tidak ditampilkan. Berikut data mentah dari tabel:",
        citations,
        verification: {
          passed: false,
          checked: verification.claims.length,
          unmatched: verification.unmatched.map((c) => `${c.raw} ${c.unit}`),
          regenerated
        },
        dataWarning
      });
    }
    return json({
      answer: result.data.jawaban,
      citations,
      verification: {
        passed: true,
        checked: verification.claims.length,
        unmatched: [],
        regenerated
      },
      dataWarning,
      usage: result.usage,
      latencyMs: result.latencyMs
    });
  } catch (error) {
    return errorResponse(error, "Asisten gizi sedang tidak bisa dihubungi.");
  }
}
export {
  handler as POST,
  config
};
