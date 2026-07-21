import { randomUUID } from 'node:crypto';
import type { Role, User } from '@blog/shared';
import { users, type UserDoc } from '../lib/db.js';
import { conflict, notFound } from '../lib/errors.js';

const docToUser = (doc: UserDoc): User => ({
  id: doc._id,
  email: doc.email,
  role: doc.role,
  displayName: doc.displayName,
  createdAt: doc.createdAt.toISOString(),
});

export const createUser = async (params: {
  email: string;
  passwordHash: string;
  displayName: string;
  role: Role;
}): Promise<User> => {
  const col = await users();
  const existing = await col.findOne({ email: params.email }, { projection: { _id: 1 } });
  if (existing) throw conflict('Email already registered');

  const doc: UserDoc = {
    _id: randomUUID(),
    email: params.email,
    passwordHash: params.passwordHash,
    role: params.role,
    displayName: params.displayName,
    createdAt: new Date(),
  };
  await col.insertOne(doc);
  return docToUser(doc);
};

export const findUserByEmail = async (
  email: string,
): Promise<(User & { passwordHash: string }) | undefined> => {
  const col = await users();
  const doc = await col.findOne({ email });
  if (!doc) return undefined;
  return { ...docToUser(doc), passwordHash: doc.passwordHash };
};

export const findUserById = async (id: string): Promise<User> => {
  const col = await users();
  const doc = await col.findOne({ _id: id });
  if (!doc) throw notFound('User not found');
  return docToUser(doc);
};
