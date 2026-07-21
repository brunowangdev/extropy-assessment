import { z } from 'zod';

export const tagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Tags: lowercase letters, digits, hyphens; must start with a letter or digit.');

export const postSchema = z.object({
  id: z.string().uuid(),
  authorId: z.string().uuid(),
  authorName: z.string(),
  title: z.string(),
  content: z.string(),
  tags: z.array(tagSchema).default([]),
  published: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string().nullable(),
});
export type Post = z.infer<typeof postSchema>;

export const createPostSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(50_000),
  tags: z.array(tagSchema).max(8).default([]),
  published: z.boolean().default(false),
});
export type CreatePostInput = z.infer<typeof createPostSchema>;

export const updatePostSchema = createPostSchema.partial();
export type UpdatePostInput = z.infer<typeof updatePostSchema>;

export const listPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
  q: z.string().trim().min(1).max(120).optional(),
  tag: tagSchema.optional(),
});
export type ListPostsQuery = z.infer<typeof listPostsQuerySchema>;

export const paginatedPostsSchema = z.object({
  items: z.array(postSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type PaginatedPosts = z.infer<typeof paginatedPostsSchema>;
