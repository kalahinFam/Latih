// server/_llm.ts
import OpenAI from "openai";
var PRICE_PER_MTOK = {
  input: Number(process.env.LLM_PRICE_INPUT_PER_MTOK ?? 0.15),
  output: Number(process.env.LLM_PRICE_OUTPUT_PER_MTOK ?? 0.6)
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

// server/_push.ts
import { createPrivateKey, createSign, randomUUID } from "node:crypto";

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

// server/_push.ts
var KEY_PREFIX = "latih:push:";
var INDEX_KEY = "latih:push:index";
var memory = /* @__PURE__ */ new Map();
var memoryStore = {
  kind: "memory",
  async put(record) {
    memory.set(record.id, record);
  },
  async remove(id) {
    memory.delete(id);
  },
  async all() {
    return [...memory.values()];
  }
};
function upstashStore(command) {
  return {
    kind: "upstash",
    async put(record) {
      await command("SET", KEY_PREFIX + record.id, JSON.stringify(record));
      await command("SADD", INDEX_KEY, record.id);
    },
    async remove(id) {
      await command("DEL", KEY_PREFIX + id);
      await command("SREM", INDEX_KEY, id);
    },
    async all() {
      const ids = await command("SMEMBERS", INDEX_KEY);
      if (!ids || ids.length === 0) return [];
      const raw = await command("MGET", ...ids.map((id) => KEY_PREFIX + id));
      const records = [];
      for (const entry of raw) {
        if (!entry) continue;
        try {
          records.push(JSON.parse(entry));
        } catch {
        }
      }
      return records;
    }
  };
}
function subscriptionStore() {
  const command = redisCommand();
  return command ? upstashStore(command) : memoryStore;
}
function newSubscriptionId() {
  return randomUUID();
}
function vapidConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    // Push services require a contact. A mailto is the convention.
    subject: process.env.VAPID_SUBJECT ?? "mailto:latih@example.com"
  };
}
var TOKEN_TTL_SECONDS = 12 * 60 * 60;
var DAY_MS = 24 * 60 * 60 * 1e3;

// server/push.ts
var config = { runtime: "nodejs" };
function isValid(value) {
  if (typeof value !== "object" || value === null) return false;
  const b = value;
  return typeof b.endpoint === "string" && // Only real push endpoints. Without this the store becomes an open relay
  // for whatever URL anyone cares to POST.
  /^https:\/\//.test(b.endpoint) && b.endpoint.length < 2e3 && typeof b.timeOfDay === "string" && /^\d{1,2}:\d{2}$/.test(b.timeOfDay) && Array.isArray(b.weekdays) && b.weekdays.length > 0 && b.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) && typeof b.utcOffsetMinutes === "number" && Math.abs(b.utcOffsetMinutes) <= 14 * 60;
}
async function handler(request) {
  const vapid = vapidConfig();
  if (request.method === "GET") {
    return json({
      configured: vapid !== null,
      publicKey: vapid?.publicKey ?? null,
      // Named so the plan page can warn that reminders will not survive a
      // redeploy when no shared store is attached.
      storage: subscriptionStore().kind
    });
  }
  if (!vapid) {
    return json(
      { error: "Pengingat belum dikonfigurasi di server (VAPID_PUBLIC_KEY belum diset)." },
      503
    );
  }
  const store = subscriptionStore();
  if (request.method === "DELETE") {
    let id;
    try {
      ({ id } = await request.json());
    } catch {
      return json({ error: "Body bukan JSON yang sah." }, 400);
    }
    if (typeof id !== "string") return json({ error: 'Field "id" wajib diisi.' }, 400);
    await store.remove(id);
    return json({ ok: true });
  }
  if (request.method !== "POST") return json({ error: "Gunakan GET, POST, atau DELETE." }, 405);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body bukan JSON yang sah." }, 400);
  }
  if (!isValid(body)) {
    return json({ error: "Data langganan pengingat tidak lengkap atau tidak valid." }, 400);
  }
  const record = {
    // Reusing the client's id makes re-subscribing idempotent: a device that
    // visits daily should refresh one row, not accumulate one per visit.
    id: body.id ?? newSubscriptionId(),
    endpoint: body.endpoint,
    timeOfDay: body.timeOfDay,
    weekdays: [...new Set(body.weekdays)].sort((a, b) => a - b),
    utcOffsetMinutes: body.utcOffsetMinutes,
    createdAt: Date.now()
  };
  try {
    await store.put(record);
  } catch {
    return json({ error: "Penyimpanan pengingat sedang tidak bisa dihubungi." }, 503);
  }
  return json({ ok: true, id: record.id });
}
export {
  config,
  handler as default
};
