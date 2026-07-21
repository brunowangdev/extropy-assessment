/**
 * Char-based token estimator. A real tokenizer (tiktoken, o200k_base) requires
 * WASM which hurts Lambda cold-start weight by 2-3MB. English averages ~4
 * chars/token, code is closer to 3; we round up so budgets are safe rather
 * than tight. Only used for accounting/budgeting, never for billing.
 */
export const estimateTokens = (text: string): number => {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
};

/**
 * Per-1M-token USD pricing. Kept in code because OpenRouter's pricing endpoint
 * requires an API call per model — for cost dashboards this table is
 * refreshed by hand at release time. Unknown models return 0 rather than
 * throw, so a swap to a new model never breaks logging.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'anthropic/claude-sonnet-4.5': { input: 3, output: 15 },
  'anthropic/claude-haiku-4.5': { input: 1, output: 5 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
  'openai/gpt-4o': { input: 2.5, output: 10 },
};

export type CostBreakdown = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
};

export const estimateCost = (
  model: string,
  inputTokens: number,
  outputTokens: number,
): CostBreakdown => {
  const rate = PRICING[model];
  const usd = rate ? (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000 : 0;
  return { model, inputTokens, outputTokens, usd };
};

const PER_MESSAGE_OVERHEAD = 8;

/**
 * Sliding-window trim: retain the tail (most recent turns) up to `maxTokens`.
 * Always keeps at least the newest message even if it alone would exceed the
 * budget — that's the user's active turn, letting it get dropped would break
 * the exchange more visibly than an over-budget prompt would.
 *
 * System prompts are excluded from the caller's input and re-attached
 * afterward, since they carry the RAG context and must not be trimmed.
 */
export const applySlidingWindow = <M extends { role: string; content: string }>(
  messages: M[],
  maxTokens: number,
): { kept: M[]; droppedCount: number; usedTokens: number } => {
  const kept: M[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cost = estimateTokens(messages[i]!.content) + PER_MESSAGE_OVERHEAD;
    if (used + cost > maxTokens && kept.length > 0) break;
    kept.unshift(messages[i]!);
    used += cost;
  }
  return { kept, droppedCount: messages.length - kept.length, usedTokens: used };
};
