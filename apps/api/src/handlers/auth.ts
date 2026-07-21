import { loginSchema, signupSchema, type AuthResponse } from '@blog/shared';
import { hashPassword, signToken, verifyPassword } from '../lib/auth.js';
import { unauthorized } from '../lib/errors.js';
import { json, parseBody, requireAuth, withHttp } from '../lib/http.js';
import { createUser, findUserByEmail, findUserById } from '../services/users.js';

export const signup = withHttp(async (event) => {
  const input = parseBody(event, signupSchema);
  const passwordHash = await hashPassword(input.password);
  const user = await createUser({
    email: input.email,
    passwordHash,
    displayName: input.displayName,
    role: input.role,
  });
  const token = signToken({
    sub: user.id,
    email: user.email,
    role: user.role,
    displayName: user.displayName,
  });
  const response: AuthResponse = { token, user };
  return json(201, response);
});

export const login = withHttp(async (event) => {
  const input = parseBody(event, loginSchema);
  const user = await findUserByEmail(input.email);
  if (!user) throw unauthorized('Invalid credentials');
  const ok = await verifyPassword(input.password, user.passwordHash);
  if (!ok) throw unauthorized('Invalid credentials');
  const token = signToken({
    sub: user.id,
    email: user.email,
    role: user.role,
    displayName: user.displayName,
  });
  const { passwordHash: _pw, ...safeUser } = user;
  const response: AuthResponse = { token, user: safeUser };
  return json(200, response);
});

export const me = withHttp(async (event) => {
  const claims = requireAuth(event);
  const user = await findUserById(claims.sub);
  return json(200, user);
});
