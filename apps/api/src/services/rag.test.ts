import { describe, expect, it } from 'vitest';
import { chunkPost } from './rag.js';
import { cosineSimilarity } from './embeddings.js';

describe('chunkPost', () => {
  it('returns one chunk for short posts', () => {
    const chunks = chunkPost('Hello', 'A short body about React hooks.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('React hooks');
    expect(chunks[0]).toContain('Hello');
  });

  it('splits long posts into multiple chunks', () => {
    const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} discusses topic ${i}.`);
    const chunks = chunkPost('Long', sentences.join(' '));
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk should be empty.
    for (const c of chunks) expect(c.length).toBeGreaterThan(0);
  });

  it('preserves content: every original sentence appears in at least one chunk', () => {
    const sentences = ['One about apples.', 'Two about bananas.', 'Three about cherries.'];
    const content = 'lorem '.repeat(200) + sentences.join(' ') + ' ' + 'ipsum '.repeat(200);
    const chunks = chunkPost('Fruit', content);
    for (const s of sentences) {
      expect(chunks.some((c) => c.includes(s))).toBe(true);
    }
  });

  it('returns empty array for empty input', () => {
    expect(chunkPost('', '')).toEqual([]);
  });
});

describe('cosineSimilarity', () => {
  it('is 1.0 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('returns 0 for shape mismatch instead of throwing', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('handles zero vectors without dividing by zero', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});
