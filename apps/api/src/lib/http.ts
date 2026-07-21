import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { z } from 'zod';
import { AppError, badRequest, toErrorResponse } from './errors.js';
import { extractBearer, verifyToken, type JwtClaims } from './auth.js';
import { newTraceId, withTrace, type TracedLogger } from './logger.js';
import { pickAllowedOrigin } from './cors.js';

export type ApiEvent = APIGatewayProxyEventV2;
export type ApiResult = APIGatewayProxyStructuredResultV2;

const corsHeaders = (event?: ApiEvent) => {
  const requestOrigin = event
    ? (event.headers['origin'] ?? event.headers['Origin'] ?? undefined)
    : undefined;
  return {
    'Access-Control-Allow-Origin': pickAllowedOrigin(requestOrigin),
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    Vary: 'Origin',
    // No Allow-Credentials: auth is via Authorization bearer, not cookies —
    // credentialed CORS would forbid the wildcard fallback anyway.
  };
};

export const json = (status: number, body: unknown): ApiResult => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

export const noContent = (): ApiResult => ({ statusCode: 204, headers: {} });

export const parseBody = <S extends z.ZodTypeAny>(event: ApiEvent, schema: S): z.output<S> => {
  if (!event.body) throw badRequest('Request body required');
  let raw: unknown;
  try {
    raw = JSON.parse(event.body);
  } catch {
    throw badRequest('Invalid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw badRequest('Validation failed', parsed.error.flatten());
  return parsed.data;
};

export const parseQuery = <S extends z.ZodTypeAny>(event: ApiEvent, schema: S): z.output<S> => {
  const parsed = schema.safeParse(event.queryStringParameters ?? {});
  if (!parsed.success) throw badRequest('Invalid query', parsed.error.flatten());
  return parsed.data;
};

export const requireAuth = (event: ApiEvent): JwtClaims => {
  const header = event.headers['authorization'] ?? event.headers['Authorization'];
  return verifyToken(extractBearer(header));
};

export type WithLogger<E> = E & { logger: TracedLogger };
export type LoggedApiEvent = WithLogger<ApiEvent>;

/**
 * Wraps a route handler with error mapping, CORS preflight, and a
 * per-request trace logger. Handler code reads `event.logger` and passes it
 * into service calls so indexing/RAG events correlate to the originating
 * HTTP request in CloudWatch.
 *
 * Errors funnel through toErrorResponse so the shape is uniform; the trace
 * id is echoed as `X-Trace-Id` for client-side reporting.
 */
export const withHttp = (
  handler: (event: LoggedApiEvent) => Promise<ApiResult>,
): ((event: ApiEvent) => Promise<ApiResult>) => async (event) => {
  const traceId = newTraceId();
  const logger = withTrace(traceId, {
    method: event.requestContext.http.method,
    path: event.requestContext.http.path,
  });

  // CORS + trace headers are applied by the wrapper so every response —
  // success, error, and preflight — carries them uniformly, using the actual
  // request origin rather than a stale env value.
  const responseHeaders = { ...corsHeaders(event), 'X-Trace-Id': traceId };

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: responseHeaders };
  }

  const startedAt = Date.now();
  try {
    const result = await handler(Object.assign(event, { logger }));
    logger.info('http.completed', {
      status: result.statusCode ?? 200,
      latencyMs: Date.now() - startedAt,
    });
    return {
      ...result,
      headers: { ...(result.headers as Record<string, string>), ...responseHeaders },
    };
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    if (!(err instanceof AppError)) logger.error('http.unhandled', { error: String(err) });
    else logger.info('http.error', { status, message: err.message });
    return {
      statusCode: status,
      headers: { 'Content-Type': 'application/json', ...responseHeaders },
      body,
    };
  }
};
