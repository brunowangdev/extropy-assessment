import '../lib/load-env.js';
import { db, posts, users } from '../lib/db.js';
import { chunks } from '../services/rag.js';

/**
 * MongoDB is schemaless — this script only creates indexes.
 * Idempotent: MongoDB skips index creation if the same spec+name already exists.
 */
const main = async () => {
  const database = await db();
  await database.command({ ping: 1 });

  const usersCol = await users();
  await usersCol.createIndex({ email: 1 }, { unique: true, name: 'email_unique' });

  const postsCol = await posts();
  await postsCol.createIndexes([
    { key: { authorId: 1, updatedAt: -1 }, name: 'author_updated' },
    { key: { published: 1, publishedAt: -1 }, name: 'published_recent' },
    { key: { tags: 1 }, name: 'tags' },
    {
      key: { title: 'text', content: 'text' },
      name: 'title_content_text',
      weights: { title: 5, content: 1 },
      default_language: 'english',
    },
  ]);

  const chunksCol = await chunks();
  await chunksCol.createIndexes([
    { key: { postId: 1 }, name: 'chunks_postId' },
    { key: { authorId: 1, published: 1, publishedAt: -1 }, name: 'chunks_visibility' },
    {
      key: { text: 'text' },
      name: 'chunks_text',
      default_language: 'english',
    },
  ]);

  console.info('MongoDB indexes ensured.');
  process.exit(0);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
