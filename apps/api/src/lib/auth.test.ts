import { beforeEach, describe, expect, it } from 'vitest';
import { extractBearer, hashPassword, signToken, verifyPassword, verifyToken } from './auth.js';
import { AppError } from './errors.js';

beforeEach(() => {
  process.env.JWT_SECRET = 'a'.repeat(64);
  process.env.MONGODB_URI = 'mongodb://localhost:27017';
});

describe('password hashing', () => {
  it('hashes and verifies correctly', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword('correct-horse-battery-staple', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('produces different hashes for the same password', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
  });
});

describe('JWT', () => {
  it('signs and verifies round-trip', () => {
    const token = signToken({
      sub: '11111111-1111-1111-1111-111111111111',
      email: 'a@b.co',
      role: 'author',
      displayName: 'A',
    });
    const claims = verifyToken(token);
    expect(claims.sub).toBe('11111111-1111-1111-1111-111111111111');
    expect(claims.role).toBe('author');
  });

  it('rejects tampered tokens', () => {
    const token = signToken({ sub: 'x', email: 'a', role: 'reader', displayName: 'A' });
    const bad = token.slice(0, -3) + 'aaa';
    expect(() => verifyToken(bad)).toThrow(AppError);
  });
});

describe('extractBearer', () => {
  it('parses valid header', () => {
    expect(extractBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('rejects missing header', () => {
    expect(() => extractBearer(undefined)).toThrow(AppError);
  });

  it('rejects wrong scheme', () => {
    expect(() => extractBearer('Basic xxx')).toThrow(AppError);
  });
});
