import { env } from './env.js';

/**
 * `CORS_ALLOWED_ORIGIN` is comma-separated so a single env var can permit
 * both `http://localhost:5173` and `http://127.0.0.1:5173` in local dev
 * (browsers treat these as distinct origins). In production this is normally
 * a single CloudFront URL.
 */
export const parseAllowedOrigins = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Pick the Access-Control-Allow-Origin value to echo back. The spec requires
 * an exact match on the request's Origin header when credentials are used,
 * and forbids wildcard in that case; even without credentials, echoing the
 * exact origin is more portable than emitting a list.
 *
 * Fallback: first configured origin. This means an unmatched cross-origin
 * request still gets a deterministic header (aiding debugging), but the
 * browser will reject it since it won't match the caller.
 */
export const pickAllowedOrigin = (requestOrigin: string | undefined): string => {
  const allowed = parseAllowedOrigins(env().CORS_ALLOWED_ORIGIN);
  if (allowed.length === 0) return '*';
  if (allowed.includes('*')) return '*';
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return allowed[0]!;
};

export const readOriginHeader = (headers: Record<string, string | undefined>): string | undefined =>
  headers['origin'] ?? headers['Origin'] ?? undefined;
