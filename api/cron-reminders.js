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
function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function privateKeyFrom(publicKey, privateKey) {
  const point = Buffer.from(publicKey.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (point.length !== 65 || point[0] !== 4) {
    throw new Error("VAPID_PUBLIC_KEY is not an uncompressed P-256 point.");
  }
  return createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: base64url(point.subarray(1, 33)),
      y: base64url(point.subarray(33, 65)),
      d: privateKey.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "")
    }
  });
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
function signVapidToken(endpoint, config2) {
  const audience = new URL(endpoint).origin;
  const header = base64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = base64url(
    Buffer.from(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1e3) + TOKEN_TTL_SECONDS,
        sub: config2.subject
      })
    )
  );
  const signer = createSign("SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign({
    key: privateKeyFrom(config2.publicKey, config2.privateKey),
    dsaEncoding: "ieee-p1363"
  });
  return `${header}.${payload}.${base64url(signature)}`;
}
async function sendPush(endpoint, config2, ttlSeconds = 3 * 60 * 60) {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `vapid t=${signVapidToken(endpoint, config2)}, k=${config2.publicKey}`,
        ttl: String(ttlSeconds),
        "content-length": "0"
      }
    });
    if (response.status === 404 || response.status === 410) return "expired";
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
var DAY_MS = 24 * 60 * 60 * 1e3;
function isDue(record, now, windowMinutes = 20) {
  const local = new Date(now + record.utcOffsetMinutes * 60 * 1e3);
  const weekday = (local.getUTCDay() + 6) % 7;
  if (!record.weekdays.includes(weekday)) return false;
  const [hours, minutes] = record.timeOfDay.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return false;
  const minutesNow = local.getUTCHours() * 60 + local.getUTCMinutes();
  const elapsed = minutesNow - (hours * 60 + minutes);
  if (elapsed < 0 || elapsed > windowMinutes) return false;
  return record.lastSentAt === void 0 || now - record.lastSentAt > DAY_MS / 2;
}

// server/cron-reminders.ts
var config = { runtime: "nodejs" };
function isAuthorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}
async function handler(request) {
  if (!isAuthorized(request)) return json({ error: "Tidak diizinkan." }, 401);
  const vapid = vapidConfig();
  if (!vapid) return json({ error: "VAPID belum dikonfigurasi." }, 503);
  const store = subscriptionStore();
  const now = Date.now();
  let due = 0;
  let sent = 0;
  let expired = 0;
  let failed = 0;
  const records = await store.all();
  for (const record of records) {
    if (!isDue(record, now)) continue;
    due += 1;
    const result = await sendPush(record.endpoint, vapid);
    if (result === "sent") {
      sent += 1;
      await store.put({ ...record, lastSentAt: now });
    } else if (result === "expired") {
      expired += 1;
      await store.remove(record.id);
    } else {
      failed += 1;
    }
  }
  return json({ checked: records.length, due, sent, expired, failed, storage: store.kind });
}
export {
  handler as GET,
  config
};
