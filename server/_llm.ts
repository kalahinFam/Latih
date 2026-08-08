/**
 * The single place the app talks to a language model.
 *
 * ## Why an interface for one provider
 *
 * Every LLM call in the product goes through `completeJson`. If the OpenAI key
 * hits a quota wall the night before the deadline — or during the recording —
 * swapping providers is one file, not a hunt through every endpoint. Cheap to
 * build now, expensive to retrofit under pressure.
 *
 * ## Why structured output rather than parsing prose
 *
 * `strict: true` makes the model's reply conform to the schema or fail loudly.
 * That removes an entire failure class ("the model answered in a slightly
 * different shape") from the UI, which would otherwise need defensive parsing
 * on a path that runs between every set.
 */

import OpenAI from 'openai';

/** Default model. Two or three sentences of Indonesian — latency matters more than depth here. */
export const DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * Price per million tokens, USD.
 *
 * ⚠️ These feed the operating-cost figure reported in the paper, so they must
 * be confirmed against the provider's current pricing page before that number
 * is published — they are not something the code can verify at runtime.
 * Override without a code change via env when they move.
 */
const PRICE_PER_MTOK = {
  input: Number(process.env.LLM_PRICE_INPUT_PER_MTOK ?? 0.15),
  output: Number(process.env.LLM_PRICE_OUTPUT_PER_MTOK ?? 0.6),
};

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  /** Estimated, from the rates above. */
  costUsd: number;
}

export interface LlmResult<T> {
  data: T;
  usage: LlmUsage;
  latencyMs: number;
  model: string;
}

export interface CompleteJsonOptions {
  system: string;
  user: string;
  /** JSON Schema. Needs `additionalProperties: false` and every key required. */
  schema: Record<string, unknown>;
  schemaName: string;
  maxTokens?: number;
  model?: string;
}

let client: OpenAI | null = null;

/**
 * Lazily constructed so importing this module does not throw when the key is
 * absent — the dev server and the unit tests both import it without one.
 */
function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'OPENAI_API_KEY belum diset. Salin .env.example ke .env lalu isi kuncinya.',
      );
    }
    client = new OpenAI({ apiKey });
  }
  return client;
}

function priceOf(promptTokens: number, completionTokens: number): number {
  const usd =
    (promptTokens / 1_000_000) * PRICE_PER_MTOK.input +
    (completionTokens / 1_000_000) * PRICE_PER_MTOK.output;
  // Six decimals: a single set costs well under a hundredth of a cent, and
  // rounding to four would report every call as zero.
  return Number(usd.toFixed(6));
}

export async function completeJson<T>(options: CompleteJsonOptions): Promise<LlmResult<T>> {
  const model = options.model ?? DEFAULT_MODEL;
  const startedAt = Date.now();

  const response = await getClient().chat.completions.create({
    model,
    max_completion_tokens: options.maxTokens ?? 400,
    messages: [
      { role: 'system', content: options.system },
      { role: 'user', content: options.user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: options.schemaName,
        strict: true,
        schema: options.schema,
      },
    },
  });

  const choice = response.choices[0];

  // A refusal is a successful HTTP response with no usable content. Reading
  // `.content` blindly would surface as a confusing JSON parse error instead
  // of the actual reason.
  if (choice?.message?.refusal) {
    throw new Error(`Model menolak permintaan: ${choice.message.refusal}`);
  }

  const content = choice?.message?.content;
  if (!content) {
    // Hitting the token ceiling truncates mid-JSON; say which it was.
    const reason = choice?.finish_reason ?? 'unknown';
    throw new Error(`Model tidak mengembalikan konten (finish_reason: ${reason}).`);
  }

  const promptTokens = response.usage?.prompt_tokens ?? 0;
  const completionTokens = response.usage?.completion_tokens ?? 0;

  return {
    data: JSON.parse(content) as T,
    usage: {
      promptTokens,
      completionTokens,
      costUsd: priceOf(promptTokens, completionTokens),
    },
    latencyMs: Date.now() - startedAt,
    model,
  };
}

/** JSON response with the headers every endpoint here wants. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Map an internal failure onto something safe to send to a browser.
 *
 * Provider errors can carry request context; forwarding them verbatim would
 * leak internals to anyone who can reach the endpoint.
 */
export function errorResponse(error: unknown, fallback: string): Response {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[api]', message);

  const isConfig = message.includes('OPENAI_API_KEY');
  return json({ error: isConfig ? message : fallback }, isConfig ? 500 : 502);
}
