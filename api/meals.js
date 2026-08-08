// server/meals.ts
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

// web/src/core/pantry.ts
var CATEGORY_LABELS = {
  pokok: "Makanan pokok",
  "protein-hewani": "Protein hewani",
  "protein-nabati": "Protein nabati",
  sayur: "Sayur",
  buah: "Buah",
  lemak: "Minyak dan lemak"
};
var TYPICAL_PORTION_G = {
  pokok: [75, 250],
  "protein-hewani": [50, 150],
  "protein-nabati": [50, 150],
  sayur: [50, 150],
  buah: [80, 200],
  lemak: [5, 15]
};
var MIN_PORTION_G = 5;
var MAX_PORTION_G = 500;
var PANTRY_CODES = {
  pokok: [
    "AP001",
    // Nasi
    "AP005",
    // Nasi beras merah
    "AP024",
    // Roti putih
    "BR013",
    // Kentang, segar
    "AP010",
    // Jagung muda, rebus
    "BP075"
    // Ubi Cilembu
  ],
  "protein-hewani": [
    "HR002",
    // Telur ayam ras, segar
    "FR005",
    // Ayam, daging, segar
    "FR025",
    // Sapi, daging, kurus, segar
    "GR070",
    // Ikan tongkol, segar
    "GR050",
    // Ikan oci (kembung), segar
    "GR084",
    // Udang, segar
    "JR006"
    // Susu sapi, segar
  ],
  "protein-nabati": [
    "CP077",
    // Tempe kedelai murni, mentah
    "CP061",
    // Tahu, mentah
    "CP060"
    // Susu kedelai
  ],
  sayur: [
    "DR100",
    // Kangkung, segar
    "DP001",
    // Bayam, kukus
    "DR166",
    // Wortel, segar
    "DR013",
    // Buncis, segar
    "DR097",
    // Kacang panjang, segar
    "DR141"
    // Sawi, segar
  ],
  buah: [
    "ER074",
    // Pisang ambon, segar
    "ER073",
    // Pepaya, segar
    "ER004",
    // Apel, segar
    "ER054",
    // Mangga, segar
    "ER105",
    // Semangka, segar
    "ER001"
    // Alpukat, segar
  ],
  lemak: [
    "KR011",
    // Minyak kelapa
    "KR014"
    // Minyak zaitun
  ]
};
function pantryEntries(table, excluded = []) {
  const byCode = new Map(table.foods.map((food) => [food.code, food]));
  const blocked = new Set(excluded);
  const entries = [];
  for (const [category, codes] of Object.entries(PANTRY_CODES)) {
    for (const code of codes) {
      if (blocked.has(code)) continue;
      const food = byCode.get(code);
      if (food && !food.suspect) entries.push({ category, food });
    }
  }
  return entries;
}
function formatPantryForPrompt(table, excluded = []) {
  const entries = pantryEntries(table, excluded);
  const sections = [];
  for (const category of Object.keys(PANTRY_CODES)) {
    const foods = entries.filter((entry) => entry.category === category);
    if (foods.length === 0) continue;
    const [min, max] = TYPICAL_PORTION_G[category];
    sections.push(
      `${CATEGORY_LABELS[category]} (porsi lazim ${min}\u2013${max} gram):
` + foods.map(
        ({ food }) => `  ${food.code} | ${food.name} | per ${food.basisG} g: ${food.energyKcal} kkal, protein ${food.proteinG} g, lemak ${food.fatG} g, karbohidrat ${food.carbG} g`
      ).join("\n")
    );
  }
  return sections.join("\n\n");
}

// web/src/core/tkpi.ts
function allowedValuesFor(foods) {
  const values = [];
  for (const food of foods) {
    values.push(food.basisG, food.energyKcal, food.proteinG, food.fatG, food.carbG);
    if (food.fiberG !== void 0) values.push(food.fiberG);
  }
  return values;
}
function scaleToPortion(food, grams) {
  const factor = grams / food.basisG;
  return {
    energyKcal: round1(food.energyKcal * factor),
    proteinG: round1(food.proteinG * factor),
    fatG: round1(food.fatG * factor),
    carbG: round1(food.carbG * factor)
  };
}
function sumPortions(portions) {
  return portions.reduce(
    (total, portion) => {
      const scaled = scaleToPortion(portion.food, portion.grams);
      return {
        energyKcal: round1(total.energyKcal + scaled.energyKcal),
        proteinG: round1(total.proteinG + scaled.proteinG),
        fatG: round1(total.fatG + scaled.fatG),
        carbG: round1(total.carbG + scaled.carbG)
      };
    },
    { energyKcal: 0, proteinG: 0, fatG: 0, carbG: 0 }
  );
}
function round1(value) {
  return Math.round(value * 10) / 10;
}
function allowedValuesForPortions(portions) {
  const values = allowedValuesFor(portions.map((p) => p.food));
  for (const portion of portions) {
    values.push(portion.grams);
    const scaled = scaleToPortion(portion.food, portion.grams);
    values.push(scaled.energyKcal, scaled.proteinG, scaled.fatG, scaled.carbG);
  }
  const total = sumPortions(portions);
  values.push(total.energyKcal, total.proteinG, total.fatG, total.carbG);
  return values;
}

// web/src/core/meals.ts
var BUDGET_TOLERANCE = 0.25;
var MealRejectedError = class extends Error {
};
function buildOption(chosen, table, budgetKcal, excluded = []) {
  const allowed = new Map(
    pantryEntries(table, excluded).map((entry) => [entry.food.code, entry.food])
  );
  if (!Array.isArray(chosen.items) || chosen.items.length === 0) {
    throw new MealRejectedError("Opsi tidak berisi bahan apa pun.");
  }
  const portions = [];
  for (const item of chosen.items) {
    const food = allowed.get(item.code);
    if (!food) {
      throw new MealRejectedError(`Bahan di luar daftar: ${item.code}`);
    }
    if (!Number.isFinite(item.grams) || item.grams < MIN_PORTION_G || item.grams > MAX_PORTION_G) {
      throw new MealRejectedError(`Porsi tidak masuk akal untuk ${food.name}: ${item.grams} g`);
    }
    portions.push({ food, grams: Math.round(item.grams) });
  }
  const total = sumPortions(portions);
  const delta = total.energyKcal - budgetKcal;
  if (budgetKcal > 0 && Math.abs(delta) > budgetKcal * BUDGET_TOLERANCE) {
    throw new MealRejectedError(
      `Total ${total.energyKcal} kkal terlalu jauh dari target ${budgetKcal} kkal.`
    );
  }
  return {
    name: chosen.nama,
    items: portions.map((portion) => ({
      code: portion.food.code,
      name: portion.food.name,
      grams: portion.grams,
      nutrients: scaleToPortion(portion.food, portion.grams)
    })),
    total,
    note: chosen.catatan,
    budgetDeltaKcal: Math.round(delta)
  };
}
function buildOptions(chosen, table, budgetKcal, excluded = []) {
  const options = [];
  const rejected = [];
  for (const candidate of chosen) {
    try {
      options.push(buildOption(candidate, table, budgetKcal, excluded));
    } catch (error) {
      rejected.push(error instanceof MealRejectedError ? error.message : String(error));
    }
  }
  return { options, rejected };
}

// server/meals.ts
var config = { runtime: "nodejs" };
var DATA_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "tkpi", "tkpi.json");
var cached = null;
async function loadTable() {
  if (!cached) cached = JSON.parse(await readFile(DATA_PATH, "utf8"));
  return cached;
}
var SLOTS = ["pagi", "siang", "malam"];
var SLOT_LABELS = {
  pagi: "sarapan",
  siang: "makan siang",
  malam: "makan malam"
};
var MIN_BUDGET_KCAL = 100;
var MAX_BUDGET_KCAL = 2e3;
var OPTIONS_PER_MEAL = 4;
var MAX_OPTIONS_SHOWN = 3;
var SCHEMA = {
  type: "object",
  properties: {
    opsi: {
      type: "array",
      description: `Tepat ${OPTIONS_PER_MEAL} opsi menu yang berbeda.`,
      items: {
        type: "object",
        properties: {
          nama: { type: "string", description: 'Nama menu singkat, misalnya "Nasi telur tumis kangkung".' },
          items: {
            type: "array",
            description: "Bahan-bahan menu ini.",
            items: {
              type: "object",
              properties: {
                code: { type: "string", description: "Kode TKPI persis dari daftar bahan." },
                grams: { type: "number", description: "Porsi dalam gram." }
              },
              required: ["code", "grams"],
              additionalProperties: false
            }
          },
          catatan: { type: "string", description: "Satu kalimat kenapa menu ini cocok. Tanpa angka." }
        },
        required: ["nama", "items", "catatan"],
        additionalProperties: false
      }
    }
  },
  required: ["opsi"],
  additionalProperties: false
};
var SYSTEM = `Kamu perencana menu harian untuk orang Indonesia yang sedang
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
  (kkal per 100 g \xD7 gram \xF7 100), lalu jumlahkan. Kesalahan paling sering adalah
  porsi TERLALU KECIL sehingga totalnya jauh di bawah target \u2014 kalau perkiraanmu
  masih kurang, besarkan porsinya atau tambah satu bahan lagi. Perkiraan ini
  hanya untuk kamu sendiri; jangan ditulis di jawaban.
- Bahasa Indonesia sehari-hari.
- DILARANG memberi klaim kesehatan, saran medis, atau janji hasil.`;
var STRICTER_SUFFIX = `

PERINGATAN: Percobaan sebelumnya ditolak. Periksa ulang: pakai hanya kode dari
daftar, gunakan porsi lazim yang disebutkan tiap kategori, dan susun agar total
kalorinya mendekati target. Jangan menulis angka apa pun selain "grams".`;
function buildPrompt(table, req) {
  const emphasis = req.isTrainingDay ? "Hari ini hari latihan, jadi utamakan bahan berprotein." : "Hari ini hari istirahat.";
  const protein = req.proteinTargetG ? ` Target protein harian sekitar ${req.proteinTargetG} gram, dibagi ke tiga waktu makan.` : "";
  const prefer = req.preferCodes && req.preferCodes.length > 0 ? `

Kalau cocok, dahulukan bahan ini karena biasanya ada di rumah: ${req.preferCodes.join(", ")}.` : "";
  return `Daftar bahan yang boleh dipakai:

${formatPantryForPrompt(table, req.excludeCodes ?? [])}

Waktu makan: ${SLOT_LABELS[req.slot]}
Target energi untuk waktu makan ini: sekitar ${req.budgetKcal} kkal
${emphasis}${protein}${prefer}

Buat tepat ${OPTIONS_PER_MEAL} opsi menu.`;
}
function isValidRequest(value) {
  if (typeof value !== "object" || value === null) return false;
  const r = value;
  return SLOTS.includes(r.slot) && typeof r.budgetKcal === "number" && Number.isFinite(r.budgetKcal) && r.budgetKcal >= MIN_BUDGET_KCAL && r.budgetKcal <= MAX_BUDGET_KCAL && typeof r.isTrainingDay === "boolean" && (r.excludeCodes === void 0 || Array.isArray(r.excludeCodes)) && (r.preferCodes === void 0 || Array.isArray(r.preferCodes));
}
function stripUngroundedNotes(options, table) {
  return options.map((option) => {
    if (!option.note) return option;
    const portions = option.items.map((item) => ({
      food: table.foods.find((f) => f.code === item.code),
      grams: item.grams
    }));
    const verification = verifyGrounding(option.note, allowedValuesForPortions(portions));
    return verification.passed ? option : { ...option, note: void 0 };
  });
}
async function handler(request) {
  if (request.method !== "POST") return json({ error: "Gunakan POST." }, 405);
  const limited = await checkLimit(request, LIMITS.meals);
  if (limited) return limited;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body bukan JSON yang sah." }, 400);
  }
  if (!isValidRequest(body)) {
    return json(
      { error: `Butuh slot (pagi/siang/malam), budgetKcal ${MIN_BUDGET_KCAL}\u2013${MAX_BUDGET_KCAL}, dan isTrainingDay.` },
      400
    );
  }
  try {
    const table = await loadTable();
    const prompt = buildPrompt(table, body);
    let result = await completeJson({
      system: SYSTEM,
      user: prompt,
      schema: SCHEMA,
      schemaName: "opsi_menu",
      maxTokens: 700
    });
    const excluded = body.excludeCodes ?? [];
    let built = buildOptions(result.data.opsi ?? [], table, body.budgetKcal, excluded);
    let regenerated = false;
    if (built.options.length === 0) {
      regenerated = true;
      result = await completeJson({
        system: SYSTEM + STRICTER_SUFFIX,
        user: prompt,
        schema: SCHEMA,
        schemaName: "opsi_menu",
        maxTokens: 700
      });
      built = buildOptions(result.data.opsi ?? [], table, body.budgetKcal, excluded);
    }
    if (built.options.length === 0) {
      return json(
        {
          options: [],
          rejected: built.rejected,
          regenerated,
          message: "Belum berhasil menyusun menu yang totalnya mendekati target. Coba lagi, atau sesuaikan target kalorimu."
        },
        200
      );
    }
    return json({
      options: stripUngroundedNotes(built.options, table).slice(0, MAX_OPTIONS_SHOWN),
      rejected: built.rejected,
      regenerated,
      budgetKcal: body.budgetKcal,
      usage: result.usage,
      latencyMs: result.latencyMs
    });
  } catch (error) {
    return errorResponse(error, "Perencana menu sedang tidak bisa dihubungi.");
  }
}
export {
  config,
  handler as default
};
