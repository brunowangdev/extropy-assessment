import { MongoClient, type Collection, type Db } from 'mongodb';
import type { Role } from '@blog/shared';
import { env } from './env.js';

export type UserDoc = {
  _id: string;
  email: string;
  passwordHash: string;
  role: Role;
  displayName: string;
  createdAt: Date;
};

export type PostDoc = {
  _id: string;
  authorId: string;
  authorName: string;
  title: string;
  content: string;
  tags: string[];
  published: boolean;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
};

let cached: { client: MongoClient; db: Db } | undefined;

/**
 * Module-scoped MongoClient. Lambda's single-concurrency container model means
 * we connect once per warm container and reuse across invocations. The client
 * pools connections internally.
 */
export const db = async (): Promise<Db> => {
  if (cached) return cached.db;
  const { MONGODB_URI, MONGODB_DB } = env();
  const client = new MongoClient(MONGODB_URI, {
    // Small pool — one warm Lambda container serves one request at a time.
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 10_000,
  });
  await client.connect();
  const database = client.db(MONGODB_DB);
  cached = { client, db: database };
  return database;
};

export const users = async (): Promise<Collection<UserDoc>> =>
  (await db()).collection<UserDoc>('users');

export const posts = async (): Promise<Collection<PostDoc>> =>
  (await db()).collection<PostDoc>('posts');
