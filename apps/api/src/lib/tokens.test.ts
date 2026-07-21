import { describe, expect, it } from 'vitest';
import { applySlidingWindow, estimateCost, estimateTokens } from './tokens.js';

describe('estimateTokens', () => {
  it('returns 0 for empty', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('rounds up (safe overestimate)', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('estimateCost', () => {
  it('prices known model', () => {
    const c = estimateCost('anthropic/claude-sonnet-4.5', 1_000_000, 1_000_000);
    expect(c.usd).toBeCloseTo(18, 5);
    expect(c.model).toBe('anthropic/claude-sonnet-4.5');
  });

  it('returns 0 for unknown model rather than throwing', () => {
    const c = estimateCost('unknown/model', 100_000, 100_000);
    expect(c.usd).toBe(0);
  });
});

describe('applySlidingWindow', () => {
  const mk = (n: number, content: string) => ({ role: n % 2 ? 'user' : 'assistant', content });

  it('keeps everything within budget', () => {
    const msgs = [mk(0, 'a'), mk(1, 'b'), mk(2, 'c')];
    const { kept, droppedCount } = applySlidingWindow(msgs, 1000);
    expect(kept).toEqual(msgs);
    expect(droppedCount).toBe(0);
  });

  it('drops oldest first', () => {
    const long = 'x'.repeat(2000); // ~500 tokens
    const msgs = [mk(0, long), mk(1, long), mk(2, 'tail')];
    const { kept, droppedCount } = applySlidingWindow(msgs, 600);
    expect(kept[kept.length - 1]!.content).toBe('tail');
    expect(droppedCount).toBeGreaterThan(0);
  });

  it('always keeps the newest message even if over-budget', () => {
    const huge = 'z'.repeat(100_000);
    const msgs = [mk(0, 'a'), mk(1, huge)];
    const { kept } = applySlidingWindow(msgs, 100);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.content).toBe(huge);
  });
});
