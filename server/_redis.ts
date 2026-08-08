/**
 * Upstash Redis over its REST API, with plain `fetch`.
 *
 * Two callers need durable state across serverless invocations: push
 * subscriptions (`_push.ts`) and the rate-limit counters (`_ratelimit.ts`).
 * Both reach it through here rather than each building their own client, so
 * there is one place that knows the wire format and one place to change if the
 * provider does.
 *
 * No SDK. The REST protocol is a JSON array of command arguments, which is
 * roughly the amount of code an import statement would have cost anyway.
 */

/** A Redis command: arguments in, decoded `result` out. */
export type RedisCommand = (...args: (string | number)[]) => Promise<unknown>;

/**
 * The configured client, or `null` when Upstash is not set up.
 *
 * Returning `null` rather than throwing is deliberate: every caller here has a
 * working degraded mode (in-memory storage, in-memory counters), and a missing
 * optional dependency must not take down endpoints that would otherwise serve.
 * The callers decide what "no Redis" means for them; this only reports it.
 */
export function redisCommand(): RedisCommand | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  return async (...args) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error(`Upstash ${response.status}`);
    return ((await response.json()) as { result: unknown }).result;
  };
}
