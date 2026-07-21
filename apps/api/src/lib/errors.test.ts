import { describe, expect, it } from 'vitest';
import { AppError, badRequest, notFound, toErrorResponse } from './errors.js';

describe('error helpers', () => {
  it('badRequest is 400', () => {
    expect(badRequest('bad').status).toBe(400);
  });

  it('notFound is 404', () => {
    expect(notFound().status).toBe(404);
  });

  it('toErrorResponse serializes AppError', () => {
    const r = toErrorResponse(new AppError(403, 'nope'));
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toBe('nope');
  });

  it('toErrorResponse maps unknown to 500', () => {
    const r = toErrorResponse(new Error('boom'));
    expect(r.status).toBe(500);
    expect(JSON.parse(r.body).error).toBe('Internal server error');
  });
});
