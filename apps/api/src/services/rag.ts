import type { Collection } from 'mongodb';
import type { Role } from '@blog/shared';
import { db, posts as postsCol, type PostDoc } from '../lib/db.js';
import type { TracedLogger } from '../lib/logger.js';
import { estimateTokens } from '../lib/tokens.js';
import { cosineSimilarity, getEmbedder } from './embeddings.js';

export type ChunkDoc = {
  _id: string;
  postId: string;
  authorId: string;
  published: boolean;
  publishedAt: Date | null;
  chunkIndex: number;
  text: string;
  embedding: number[];
  title: string;
  updatedAt: Date;
};

export const chunks = async (): Promise<Collection<ChunkDoc>> =>
  (await db()).collection<ChunkDoc>('post_chunks');

const CHUNK_TARGET_TOKENS = 200;
const CHUNK_OVERLAP_TOKENS = 40;
const MAX_CHUNKS_PER_POST = 40;

/**
 * Sentence-boundary chunker with token-count overlap. Sentence detection is
 * heuristic (`.?!` + whitespace) — good enough for prose blog content, and
 * cheaper than pulling in a full NLP dep. Overlap preserves recall for facts
 * that straddle a chunk boundary. Total chunks per post are capped so a
 * pathologically long post can't blow the embedding budget.
 */
export const chunkPost = (title: string, content: string): string[] => {
  const combined = `${title}\n\n${content}`.replace(/\s+/g, ' ').trim();
  if (!combined) return [];

  if (estimateTokens(combined) <= CHUNK_TARGET_TOKENS) return [combined];

  const sentences = combined.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0);
  const out: string[] = [];
  let buf: string[] = [];
  let bufTokens = 0;

  const flush = () => {
    if (buf.length === 0) return;
    out.push(buf.join(' '));
    // Retain the tail of the current buffer as overlap for the next chunk.
    const retained: string[] = [];
    let retainedTokens = 0;
    for (let i = buf.length - 1; i >= 0; i -= 1) {
      const rt = estimateTokens(buf[i]!);
      if (retainedTokens + rt > CHUNK_OVERLAP_TOKENS) break;
      retained.unshift(buf[i]!);
      retainedTokens += rt;
    }
    buf = retained;
    bufTokens = retainedTokens;
  };

  for (const s of sentences) {
    const t = estimateTokens(s);
    if (bufTokens + t > CHUNK_TARGET_TOKENS) flush();
    buf.push(s);
    bufTokens += t;
    if (out.length >= MAX_CHUNKS_PER_POST) break;
  }
  if (buf.length > 0 && out.length < MAX_CHUNKS_PER_POST) out.push(buf.join(' '));
  return out;
};

export type IndexablePost = {
  id: string;
  authorId: string;
  title: string;
  content: string;
  published: boolean;
  publishedAt: string | null;
};

/**
 * Re-index a post. Fails open — an embedding provider outage never blocks the
 * write path; we log and let the next update retry. Production would move
 * this behind an SQS queue for durable retries + backpressure; for the
 * assessment we call it inline.
 */
export const indexPost = async (
  post: IndexablePost,
  logger?: TracedLogger,
): Promise<void> => {
  const embedder = getEmbedder();
  if (!embedder.isConfigured) {
    logger?.debug('rag.skipped.noembedder', { postId: post.id });
    return;
  }

  const col = await chunks();
  const parts = chunkPost(post.title, post.content);
  if (parts.length === 0) {
    await col.deleteMany({ postId: post.id });
    return;
  }

  let vectors: number[][];
  try {
    vectors = await embedder.embed(parts, logger);
  } catch (err) {
    logger?.warn('rag.embed.failed', {
      postId: post.id,
      chunks: parts.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const now = new Date();
  const docs: ChunkDoc[] = parts.map((text, i) => ({
    _id: `${post.id}#${i}`,
    postId: post.id,
    authorId: post.authorId,
    published: post.published,
    publishedAt: post.publishedAt ? new Date(post.publishedAt) : null,
    chunkIndex: i,
    text,
    embedding: vectors[i]!,
    title: post.title,
    updatedAt: now,
  }));

  await col.deleteMany({ postId: post.id });
  await col.insertMany(docs);
  logger?.info('rag.indexed', {
    postId: post.id,
    chunks: docs.length,
    dim: vectors[0]?.length ?? 0,
  });
};

export const removePostFromIndex = async (
  postId: string,
  logger?: TracedLogger,
): Promise<void> => {
  const col = await chunks();
  const { deletedCount } = await col.deleteMany({ postId });
  logger?.info('rag.removed', { postId, deletedCount });
};

export type RetrievedChunk = {
  postId: string;
  title: string;
  text: string;
  score: number;
  published: boolean;
  publishedAt: Date | null;
  chunkIndex: number;
};

type VisibilityFilter = { userId: string; role: Role };

const buildVisibility = (v: VisibilityFilter) =>
  v.role === 'author'
    ? { $or: [{ published: true }, { authorId: v.userId }] }
    : { published: true };

/**
 * Hybrid retrieval:
 *   1. Vector top-K via in-memory cosine over the visibility-filtered set.
 *      Fine at assessment scale (~O(chunks * dim) per query = tens of ms
 *      for hundreds of posts). Production upgrade: Atlas Vector Search
 *      `$vectorSearch` stage, which pushes the scan to the storage engine.
 *   2. Lexical top-K via the MongoDB text index on chunk.text.
 *   3. Reciprocal Rank Fusion (RRF) with the standard k=60 smoothing —
 *      cheaper than a cross-encoder rerank, and doesn't require a second LLM
 *      round-trip.
 *
 * Fully degrades: if embeddings aren't configured we return lexical-only;
 * if the text index also fails we return the empty set (chat still runs).
 */
export const retrieveChunks = async (
  query: string,
  visibility: VisibilityFilter,
  k: number,
  logger?: TracedLogger,
): Promise<RetrievedChunk[]> => {
  const filter = buildVisibility(visibility);
  const embedder = getEmbedder();

  const [vectorHits, lexicalHits] = await Promise.all([
    embedder.isConfigured ? vectorTopK(query, filter, k * 2, logger) : Promise.resolve([]),
    lexicalTopK(query, filter, k * 2, logger),
  ]);

  const RRF_C = 60;
  const fused = new Map<string, { doc: ChunkDoc; score: number }>();

  vectorHits.forEach((h, i) => {
    fused.set(h.doc._id, { doc: h.doc, score: 1 / (RRF_C + i + 1) });
  });
  lexicalHits.forEach((h, i) => {
    const prior = fused.get(h.doc._id);
    const contrib = 1 / (RRF_C + i + 1);
    if (prior) prior.score += contrib;
    else fused.set(h.doc._id, { doc: h.doc, score: contrib });
  });

  const top = Array.from(fused.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  // Recency fallback: when neither vector nor lexical produced hits — because
  // embeddings aren't configured AND the chunks index is empty (e.g. a fresh
  // install, or the platform is running without an EMBEDDING_API_KEY at all)
  // — pull recent posts from the source collection so chat stays useful.
  if (top.length === 0) {
    const recent = await recentPostFallback(visibility, k, logger);
    logger?.info('rag.retrieved', {
      query: query.slice(0, 80),
      vectorHits: 0,
      lexicalHits: 0,
      fusedReturned: 0,
      fallbackRecent: recent.length,
    });
    return recent;
  }

  logger?.info('rag.retrieved', {
    query: query.slice(0, 80),
    vectorHits: vectorHits.length,
    lexicalHits: lexicalHits.length,
    fusedReturned: top.length,
  });

  return top.map(({ doc, score }) => ({
    postId: doc.postId,
    title: doc.title,
    text: doc.text,
    score,
    published: doc.published,
    publishedAt: doc.publishedAt ?? null,
    chunkIndex: doc.chunkIndex,
  }));
};

const FALLBACK_EXCERPT_CHARS = 400;

/**
 * Recency-ordered posts, trimmed to an excerpt, as retrieval results. Used
 * only when semantic + lexical retrieval both return nothing.
 */
const recentPostFallback = async (
  visibility: VisibilityFilter,
  k: number,
  logger?: TracedLogger,
): Promise<RetrievedChunk[]> => {
  try {
    const col = await postsCol();
    const filter =
      visibility.role === 'author'
        ? { $or: [{ published: true }, { authorId: visibility.userId }] }
        : { published: true };
    const docs = await col
      .find(filter)
      .sort({ publishedAt: -1, updatedAt: -1 })
      .limit(k)
      .toArray();
    return docs.map<RetrievedChunk>((d: PostDoc) => ({
      postId: d._id,
      title: d.title,
      text: d.content.slice(0, FALLBACK_EXCERPT_CHARS),
      score: 0,
      published: d.published,
      publishedAt: d.publishedAt ?? null,
      chunkIndex: 0,
    }));
  } catch (err) {
    logger?.warn('rag.fallback.failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
};

type ScoredDoc = { doc: ChunkDoc; score: number };

const vectorTopK = async (
  query: string,
  filter: Record<string, unknown>,
  limit: number,
  logger?: TracedLogger,
): Promise<ScoredDoc[]> => {
  const embedder = getEmbedder();
  try {
    const [q] = await embedder.embed([query], logger);
    if (!q) return [];
    const col = await chunks();
    const all = await col.find(filter).toArray();
    return all
      .map((doc) => ({ doc, score: cosineSimilarity(q, doc.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } catch (err) {
    logger?.warn('rag.vector.failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
};

const lexicalTopK = async (
  query: string,
  filter: Record<string, unknown>,
  limit: number,
  logger?: TracedLogger,
): Promise<ScoredDoc[]> => {
  try {
    const col = await chunks();
    const rows = await col
      .find({ ...filter, $text: { $search: query } }, {
        projection: { score: { $meta: 'textScore' } },
      })
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .toArray();
    return rows.map((doc) => ({
      doc,
      score: (doc as unknown as { score: number }).score ?? 0,
    }));
  } catch (err) {
    logger?.warn('rag.lexical.failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
};
