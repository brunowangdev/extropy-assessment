import type { AuthorProfile } from '@blog/shared';
import { users } from '../lib/db.js';
import { notFound } from '../lib/errors.js';
import { countPublishedByAuthor, listPublishedByAuthor } from './posts.js';

/**
 * Public author profile: display info + published post count + up to 5 recent
 * published posts. Only "author" role users have a profile; requesting a
 * reader's id 404s to avoid exposing which readers exist.
 */
export const getAuthorProfile = async (id: string): Promise<AuthorProfile> => {
  const col = await users();
  const doc = await col.findOne({ _id: id });
  if (!doc || doc.role !== 'author') throw notFound('Author not found');

  const [publishedPostCount, recentPosts] = await Promise.all([
    countPublishedByAuthor(id),
    listPublishedByAuthor(id, 5),
  ]);

  return {
    id: doc._id,
    displayName: doc.displayName,
    role: doc.role,
    joinedAt: doc.createdAt.toISOString(),
    publishedPostCount,
    recentPosts,
  };
};
