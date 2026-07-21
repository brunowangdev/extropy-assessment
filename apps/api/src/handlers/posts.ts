import {
  createPostSchema,
  listPostsQuerySchema,
  updatePostSchema,
} from '@blog/shared';
import { badRequest, forbidden } from '../lib/errors.js';
import { json, noContent, parseBody, parseQuery, requireAuth, withHttp } from '../lib/http.js';
import {
  createPost,
  deletePost,
  getVisiblePost,
  listByAuthor,
  listPublished,
  listPublishedTags,
  updatePost,
} from '../services/posts.js';
import { verifyToken, extractBearer } from '../lib/auth.js';

const optionalAuth = (event: Parameters<typeof requireAuth>[0]) => {
  const header = event.headers['authorization'] ?? event.headers['Authorization'];
  if (!header) return undefined;
  try {
    return verifyToken(extractBearer(header));
  } catch {
    return undefined;
  }
};

export const listPublic = withHttp(async (event) => {
  const query = parseQuery(event, listPostsQuerySchema);
  const result = await listPublished(query);
  return json(200, result);
});

export const listMine = withHttp(async (event) => {
  const claims = requireAuth(event);
  if (claims.role !== 'author') throw forbidden('Author role required');
  const posts = await listByAuthor(claims.sub);
  return json(200, posts);
});

export const getOne = withHttp(async (event) => {
  const id = event.pathParameters?.id;
  if (!id) throw badRequest('Missing post id');
  const viewer = optionalAuth(event);
  const post = await getVisiblePost(id, viewer?.sub);
  return json(200, post);
});

export const create = withHttp(async (event) => {
  const claims = requireAuth(event);
  if (claims.role !== 'author') throw forbidden('Author role required');
  const input = parseBody(event, createPostSchema);
  const post = await createPost(claims.sub, input, event.logger);
  return json(201, post);
});

export const update = withHttp(async (event) => {
  const claims = requireAuth(event);
  if (claims.role !== 'author') throw forbidden('Author role required');
  const id = event.pathParameters?.id;
  if (!id) throw badRequest('Missing post id');
  const input = parseBody(event, updatePostSchema);
  const post = await updatePost(id, claims.sub, input, event.logger);
  return json(200, post);
});

export const remove = withHttp(async (event) => {
  const claims = requireAuth(event);
  if (claims.role !== 'author') throw forbidden('Author role required');
  const id = event.pathParameters?.id;
  if (!id) throw badRequest('Missing post id');
  await deletePost(id, claims.sub, event.logger);
  return noContent();
});

export const listTags = withHttp(async () => {
  const tags = await listPublishedTags();
  return json(200, { tags });
});
