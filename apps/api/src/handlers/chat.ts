import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { chatRequestSchema, type ChatStreamFrame } from '@blog/shared';
import { extractBearer, verifyToken, type JwtClaims } from '../lib/auth.js';
import { env } from '../lib/env.js';
import { AppError } from '../lib/errors.js';
import { newTraceId, withTrace } from '../lib/logger.js';
import { pickAllowedOrigin } from '../lib/cors.js';
import { streamChat } from '../services/chat.js';

declare const awslambda: {
  streamifyResponse: (
    handler: (
      event: LambdaFunctionURLEvent,
      responseStream: NodeJS.WritableStream & { setContentType?: (t: string) => void },
    ) => Promise<void>,
  ) => unknown;
  HttpResponseStream?: {
    from: (
      stream: NodeJS.WritableStream,
      meta: { statusCode: number; headers?: Record<string, string> },
    ) => NodeJS.WritableStream;
  };
};

const encoder = new TextEncoder();

const writeFrame = (stream: NodeJS.WritableStream, frame: ChatStreamFrame): void => {
  stream.write(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
};

const readBody = (event: LambdaFunctionURLEvent): string => {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
};

const openStream = (
  rawStream: NodeJS.WritableStream,
  status: number,
  requestOrigin: string | undefined,
  extraHeaders: Record<string, string> = {},
): NodeJS.WritableStream => {
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': pickAllowedOrigin(requestOrigin),
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    Vary: 'Origin',
    ...extraHeaders,
  };
  return awslambda.HttpResponseStream?.from
    ? awslambda.HttpResponseStream.from(rawStream, { statusCode: status, headers })
    : rawStream;
};

/**
 * Authenticate + validate BEFORE opening the SSE stream so 401/400 are real
 * HTTP status codes, not `200 OK` with an inline error frame. Only after
 * inputs are known-good do we commit to a `text/event-stream` response.
 */
const authenticate = (event: LambdaFunctionURLEvent): JwtClaims => {
  const header =
    event.headers['authorization'] ?? event.headers['Authorization'] ?? undefined;
  return verifyToken(extractBearer(header));
};

export const handler = awslambda.streamifyResponse(async (event, rawStream) => {
  const traceId = newTraceId();
  const method = event.requestContext.http.method;
  const requestOrigin = event.headers['origin'] ?? event.headers['Origin'] ?? undefined;

  if (method === 'OPTIONS') {
    // Lambda Function URL response streaming only flushes the status+headers
    // prelude set by `HttpResponseStream.from()` once the stream is written to.
    // Ending a zero-byte stream drops the prelude, so the CORS headers never
    // reach the browser and the preflight fails with "No 'Access-Control-Allow-
    // Origin' header is present". Write a byte to commit the prelude. (Status is
    // 200 rather than 204 because a 204 must carry no body.)
    const s = openStream(rawStream, 200, requestOrigin);
    s.write(encoder.encode('\n'));
    s.end();
    return;
  }

  let claims: JwtClaims;
  try {
    claims = authenticate(event);
  } catch (err) {
    const status = err instanceof AppError ? err.status : 401;
    const message = err instanceof Error ? err.message : 'Unauthorized';
    const s = openStream(rawStream, status, requestOrigin, {
      'Content-Type': 'application/json',
      'X-Trace-Id': traceId,
    });
    s.write(encoder.encode(JSON.stringify({ error: message, traceId })));
    s.end();
    return;
  }

  let rawBody: unknown;
  try {
    rawBody = JSON.parse(readBody(event) || '{}');
  } catch {
    const s = openStream(rawStream, 400, requestOrigin, {
      'Content-Type': 'application/json',
      'X-Trace-Id': traceId,
    });
    s.write(encoder.encode(JSON.stringify({ error: 'Invalid JSON', traceId })));
    s.end();
    return;
  }
  const parsed = chatRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const s = openStream(rawStream, 400, requestOrigin, {
      'Content-Type': 'application/json',
      'X-Trace-Id': traceId,
    });
    s.write(
      encoder.encode(
        JSON.stringify({ error: 'Invalid chat request', details: parsed.error.flatten(), traceId }),
      ),
    );
    s.end();
    return;
  }

  if (!env().OPENROUTER_API_KEY) {
    const s = openStream(rawStream, 503, requestOrigin, {
      'Content-Type': 'application/json',
      'X-Trace-Id': traceId,
    });
    s.write(encoder.encode(JSON.stringify({ error: 'AI is not configured', traceId })));
    s.end();
    return;
  }

  const stream = openStream(rawStream, 200, requestOrigin, { 'X-Trace-Id': traceId });
  const logger = withTrace(traceId, {
    userId: claims.sub,
    role: claims.role,
    endpoint: 'chat',
  });

  logger.info('chat.request.received', {
    turns: parsed.data.messages.length,
  });

  try {
    await streamChat(
      {
        userId: claims.sub,
        role: claims.role,
        displayName: claims.displayName,
        messages: parsed.data.messages,
        logger,
      },
      (frame) => writeFrame(stream, frame),
    );
  } catch (err) {
    const message =
      err instanceof AppError ? err.message : err instanceof Error ? err.message : 'Unknown error';
    logger.error('chat.handler.exception', {
      error: message,
      isAppError: err instanceof AppError,
    });
    writeFrame(stream, { type: 'error', message });
  } finally {
    stream.end();
  }
});
