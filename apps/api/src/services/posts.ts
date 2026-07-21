import { randomUUID } from 'node:crypto';
import type { Filter, Sort } from 'mongodb';
import type { CreatePostInput, PaginatedPosts, Post, UpdatePostInput } from '@blog/shared';
import { posts as postsCol, users as usersCol, type PostDoc } from '../lib/db.js';
import { forbidden, notFound } from '../lib/errors.js';
import type { TracedLogger } from '../lib/logger.js';
import { indexPost, removePostFromIndex } from './rag.js';

const docToPost = (doc: PostDoc): Post => ({
  id: doc._id,
  authorId: doc.authorId,
  authorName: doc.authorName,
  title: doc.title,
  content: doc.content,
  tags: doc.tags ?? [],
  published: doc.published,
  createdAt: doc.createdAt.toISOString(),
  updatedAt: doc.updatedAt.toISOString(),
  publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
});

export type ListPublicOptions = {
  page: number;
  pageSize: number;
  q?: string | undefined;
  tag?: string | undefined;
};

/**
 * Public feed of published posts, with optional full-text search (`q`) and
 * tag filter. Full-text uses the `title_content_text` index; when `q` is
 * present results are ordered by relevance score, otherwise by publishedAt.
 */
export const listPublished = async (opts: ListPublicOptions): Promise<PaginatedPosts> => {
  const col = await postsCol();
  const { page, pageSize, q, tag } = opts;

  const filter: Filter<PostDoc> = { published: true };
  if (q) filter.$text = { $search: q };
  if (tag) filter.tags = tag;

  const projection = q ? { score: { $meta: 'textScore' } } : undefined;
  const sort: Sort = q
    ? { score: { $meta: 'textScore' }, publishedAt: -1 }
    : { publishedAt: -1, createdAt: -1 };

  const [items, total] = await Promise.all([
    col
      .find(filter, projection ? { projection } : undefined)
      .sort(sort)
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray(),
    col.countDocuments(filter),
  ]);

  return {
    items: items.map(docToPost),
    page,
    pageSize,
    total,
  };
};

export const listByAuthor = async (authorId: string): Promise<Post[]> => {
  const col = await postsCol();
  const docs = await col.find({ authorId }).sort({ updatedAt: -1 }).toArray();
  return docs.map(docToPost);
};

export const listPublishedByAuthor = async (
  authorId: string,
  limit = 5,
): Promise<Post[]> => {
  const col = await postsCol();
  const docs = await col
    .find({ authorId, published: true })
    .sort({ publishedAt: -1 })
    .limit(limit)
    .toArray();
  return docs.map(docToPost);
};

export const countPublishedByAuthor = async (authorId: string): Promise<number> => {
  const col = await postsCol();
  return col.countDocuments({ authorId, published: true });
};

export const getPost = async (id: string): Promise<Post> => {
  const col = await postsCol();
  const doc = await col.findOne({ _id: id });
  if (!doc) throw notFound('Post not found');
  return docToPost(doc);
};

/** Drafts are only visible to their author. */
export const getVisiblePost = async (id: string, viewerId?: string): Promise<Post> => {
  const post = await getPost(id);
  if (!post.published && post.authorId !== viewerId) throw notFound('Post not found');
  return post;
};

export const createPost = async (
  authorId: string,
  input: CreatePostInput,
  logger?: TracedLogger,
): Promise<Post> => {
  const uCol = await usersCol();
  const author = await uCol.findOne(
    { _id: authorId },
    { projection: { displayName: 1 } },
  );
  if (!author) throw notFound('Author not found');

  const now = new Date();
  const doc: PostDoc = {
    _id: randomUUID(),
    authorId,
    authorName: author.displayName,
    title: input.title,
    content: input.content,
    tags: input.tags ?? [],
    published: input.published,
    createdAt: now,
    updatedAt: now,
    publishedAt: input.published ? now : null,
  };
  const col = await postsCol();
  await col.insertOne(doc);
  const post = docToPost(doc);
  await indexPost(post, logger);
  return post;
};

export const updatePost = async (
  id: string,
  authorId: string,
  input: UpdatePostInput,
  logger?: TracedLogger,
): Promise<Post> => {
  const col = await postsCol();
  const existing = await col.findOne({ _id: id });
  if (!existing) throw notFound('Post not found');
  if (existing.authorId !== authorId) throw forbidden('Not your post');

  const nextPublished = input.published ?? existing.published;
  const nextPublishedAt =
    nextPublished && !existing.published
      ? new Date()
      : existing.publishedAt;

  const update: Partial<PostDoc> = {
    updatedAt: new Date(),
    published: nextPublished,
    publishedAt: nextPublishedAt,
  };
  if (input.title !== undefined) update.title = input.title;
  if (input.content !== undefined) update.content = input.content;
  if (input.tags !== undefined) update.tags = input.tags;

  const result = await col.findOneAndUpdate(
    { _id: id },
    { $set: update },
    { returnDocument: 'after' },
  );
  if (!result) throw notFound('Post not found');
  const post = docToPost(result);
  // Re-index whenever title/content/publication state changes, since any of
  // those alter the chunks or their visibility in retrieval.
  const contentChanged =
    input.title !== undefined ||
    input.content !== undefined ||
    input.published !== undefined;
  if (contentChanged) await indexPost(post, logger);
  return post;
};

export const deletePost = async (
  id: string,
  authorId: string,
  logger?: TracedLogger,
): Promise<void> => {
  const col = await postsCol();
  const existing = await col.findOne({ _id: id }, { projection: { authorId: 1 } });
  if (!existing) throw notFound('Post not found');
  if (existing.authorId !== authorId) throw forbidden('Not your post');
  await col.deleteOne({ _id: id });
  await removePostFromIndex(id, logger);
};

/** Distinct published tags with counts, most-used first. */
export const listPublishedTags = async (limit = 40): Promise<Array<{ tag: string; count: number }>> => {
  const col = await postsCol();
  const rows = await col
    .aggregate<{ _id: string; count: number }>([
      { $match: { published: true, tags: { $exists: true, $ne: [] } } },
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: limit },
    ])
    .toArray();
  return rows.map((r) => ({ tag: r._id, count: r.count }));
};
