import { env } from '../lib/env.js';
import type { TracedLogger } from '../lib/logger.js';
import { withRetry } from '../lib/retry.js';

const DEFAULT_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'text-embedding-3-small';

export type Embedder = {
  isConfigured: boolean;
  model: string;
  embed: (texts: string[], logger?: TracedLogger) => Promise<number[][]>;
};

/**
 * Batch embedding client for any OpenAI-compatible `/embeddings` endpoint.
 * Configuration is intentionally decoupled from OpenRouter — as of 2026,
 * OpenRouter doesn't proxy embeddings, so we point at OpenAI (or a
 * self-hosted OpenAI-compatible server like Ollama/vLLM) directly.
 *
 * When unconfigured, returns a sentinel that RAG treats as "lexical-only" —
 * the platform still works, quality degrades gracefully.
 */
export const getEmbedder = (): Embedder => {
  const cfg = env();
  const key = cfg.EMBEDDING_API_KEY;
  const base = (cfg.EMBEDDING_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, '');
  const model = cfg.EMBEDDING_MODEL ?? DEFAULT_MODEL;

  if (!key) {
    return {
      isConfigured: false,
      model,
      embed: async () => {
        throw new Error('Embedding provider not configured');
      },
    };
  }

  const embed = async (texts: string[], logger?: TracedLogger): Promise<number[][]> => {
    if (texts.length === 0) return [];
    return withRetry(
      async (signal) => {
        const res = await fetch(`${base}/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, input: texts }),
          signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const err = new Error(
            `Embeddings ${res.status}: ${body.slice(0, 200)}`,
          ) as Error & { status?: number };
          err.status = res.status;
          throw err;
        }
        const parsed = (await res.json()) as { data: Array<{ embedding: number[] }> };
        return parsed.data.map((d) => d.embedding);
      },
      {
        op: 'embeddings.embed',
        attempts: 3,
        baseDelayMs: 400,
        maxDelayMs: 4000,
        timeoutMs: 15_000,
        logger,
      },
    );
  };

  return { isConfigured: true, model, embed };
};

/** Cosine similarity for equal-length dense vectors. Zero on shape mismatch. */
export const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
};
