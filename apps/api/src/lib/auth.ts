import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Role } from '@blog/shared';
import { env } from './env.js';
import { unauthorized } from './errors.js';

const BCRYPT_COST = 10;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export type JwtClaims = {
  sub: string;
  email: string;
  role: Role;
  displayName: string;
};

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, BCRYPT_COST);

export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);

export const signToken = (claims: JwtClaims): string =>
  jwt.sign(claims, env().JWT_SECRET, { algorithm: 'HS256', expiresIn: TOKEN_TTL_SECONDS });

export const verifyToken = (token: string): JwtClaims => {
  try {
    const decoded = jwt.verify(token, env().JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof decoded === 'string') throw unauthorized('Invalid token');
    return decoded as JwtClaims;
  } catch {
    throw unauthorized('Invalid or expired token');
  }
};

export const extractBearer = (authHeader: string | undefined): string => {
  if (!authHeader?.startsWith('Bearer ')) throw unauthorized('Missing bearer token');
  return authHeader.slice(7).trim();
};
