import './lib/load-env.js';
import { createServer } from 'node:http';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { login, me, signup } from './handlers/auth.js';
import { create, getOne, listMine, listPublic, listTags, remove, update } from './handlers/posts.js';
import { getProfile } from './handlers/authors.js';
import type { ChatStreamFrame } from '@blog/shared';
import { chatRequestSchema } from '@blog/shared';
import { extractBearer, verifyToken } from './lib/auth.js';
import { streamChat } from './services/chat.js';
import { AppError } from './lib/errors.js';
import { env } from './lib/env.js';
import { newTraceId, withTrace } from './lib/logger.js';
import { pickAllowedOrigin } from './lib/cors.js';

/**
 * Minimal Node HTTP server that adapts requests to the same handler shape
 * used in Lambda. Avoids needing SAM/serverless-offline for local dev.
 */

type Handler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>;

type Route = {
  method: string;
  pattern: RegExp;
  params: string[];
  handler: Handler;
};

const route = (method: string, path: string, handler: Handler): Route => {
  const params: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/\{([^}]+)\}/g, (_, name) => {
        params.push(name);
        return '([^/]+)';
      }) +
      '$',
  );
  return { method, pattern, params, handler };
};

const routes: Route[] = [
  route('POST', '/auth/signup', signup),
  route('POST', '/auth/login', login),
  route('GET', '/me', me),
  route('GET', '/me/posts', listMine),
  route('GET', '/posts', listPublic),
  route('GET', '/posts/{id}', getOne),
  route('POST', '/posts', create),
  route('PATCH', '/posts/{id}', update),
  route('DELETE', '/posts/{id}', remove),
  route('GET', '/tags', listTags),
  route('GET', '/authors/{id}', getProfile),
];

const PORT = Number(process.env.PORT ?? 3000);

const cors = (requestOrigin: string | undefined) => ({
  'Access-Control-Allow-Origin': pickAllowedOrigin(requestOrigin),
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  Vary: 'Origin',
});

const readOrigin = (req: { headers: Record<string, string | string[] | undefined> }): string | undefined => {
  const h = req.headers['origin'];
  if (Array.isArray(h)) return h[0];
  return h ?? undefined;
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://0.0.0.0:${PORT}`);
  const origin = readOrigin(req);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(origin));
    res.end();
    return;
  }

  // Streaming chat endpoint
  if (req.method === 'POST' && url.pathname === '/chat') {
    const traceId = newTraceId();
    const bodyChunks: Buffer[] = [];
    for await (const chunk of req) bodyChunks.push(chunk as Buffer);
    const bodyStr = Buffer.concat(bodyChunks).toString('utf8');

    // Authenticate + validate before committing to text/event-stream, so 401s
    // and 400s are real HTTP statuses in local dev too.
    let claims;
    try {
      claims = verifyToken(extractBearer(req.headers['authorization']));
    } catch (err) {
      const status = err instanceof AppError ? err.status : 401;
      const message = err instanceof Error ? err.message : 'Unauthorized';
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'X-Trace-Id': traceId,
        ...cors(origin),
      });
      res.end(JSON.stringify({ error: message, traceId }));
      return;
    }

    let rawBody: unknown;
    try {
      rawBody = JSON.parse(bodyStr || '{}');
    } catch {
      res.writeHead(400, {
        'Content-Type': 'application/json',
        'X-Trace-Id': traceId,
        ...cors(origin),
      });
      res.end(JSON.stringify({ error: 'Invalid JSON', traceId }));
      return;
    }
    const parsed = chatRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      res.writeHead(400, {
        'Content-Type': 'application/json',
        'X-Trace-Id': traceId,
        ...cors(origin),
      });
      res.end(
        JSON.stringify({
          error: 'Invalid chat request',
          details: parsed.error.flatten(),
          traceId,
        }),
      );
      return;
    }

    if (!env().OPENROUTER_API_KEY) {
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'X-Trace-Id': traceId,
        ...cors(origin),
      });
      res.end(JSON.stringify({ error: 'AI is not configured', traceId }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Trace-Id': traceId,
      ...cors(origin),
    });
    const emit = (frame: ChatStreamFrame) => {
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    };
    const logger = withTrace(traceId, {
      userId: claims.sub,
      role: claims.role,
      endpoint: 'chat',
    });
    logger.info('chat.request.received', { turns: parsed.data.messages.length });

    try {
      await streamChat(
        {
          userId: claims.sub,
          role: claims.role,
          displayName: claims.displayName,
          messages: parsed.data.messages,
          logger,
        },
        emit,
      );
    } catch (err) {
      const message =
        err instanceof AppError ? err.message : err instanceof Error ? err.message : 'Unknown';
      logger.error('chat.handler.exception', { error: message });
      emit({ type: 'error', message });
    } finally {
      res.end();
    }
    return;
  }

  // Standard REST routes
  const matched = routes.find(
    (r) => r.method === req.method && r.pattern.test(url.pathname),
  );
  if (!matched) {
    res.writeHead(404, { 'Content-Type': 'application/json', ...cors(origin) });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const pathParams: Record<string, string> = {};
  const m = url.pathname.match(matched.pattern);
  if (m) {
    matched.params.forEach((name, i) => {
      pathParams[name] = m[i + 1]!;
    });
  }

  const bodyChunks: Buffer[] = [];
  for await (const chunk of req) bodyChunks.push(chunk as Buffer);
  const body = Buffer.concat(bodyChunks).toString('utf8');

  const event: APIGatewayProxyEventV2 = {
    version: '2.0',
    routeKey: `${req.method} ${matched.pattern.source}`,
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(',') : v ?? '']),
    ),
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    pathParameters: pathParams,
    body: body || undefined,
    isBase64Encoded: false,
    requestContext: {
      accountId: 'local',
      apiId: 'local',
      domainName: '0.0.0.0',
      domainPrefix: 'local',
      requestId: crypto.randomUUID(),
      routeKey: '',
      stage: 'local',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
      http: {
        method: req.method ?? 'GET',
        path: url.pathname,
        protocol: 'HTTP/1.1',
        sourceIp: req.socket.remoteAddress ?? '127.0.0.1',
        userAgent: req.headers['user-agent'] ?? '',
      },
    },
  } as APIGatewayProxyEventV2;

  const result = await matched.handler(event);
  res.writeHead(result.statusCode ?? 200, {
    ...(result.headers as Record<string, string>),
    ...cors(origin),
  });
  res.end(result.body ?? '');
});

server.listen(PORT, () => {
  console.info(`API dev server: http://0.0.0.0:${PORT}`);
});
