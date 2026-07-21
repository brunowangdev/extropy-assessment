import { z } from 'zod';
import { postSchema } from './post.js';

export const authorProfileSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  role: z.enum(['author', 'reader']),
  joinedAt: z.string(),
  publishedPostCount: z.number().int().nonnegative(),
  recentPosts: z.array(postSchema),
});
export type AuthorProfile = z.infer<typeof authorProfileSchema>;
