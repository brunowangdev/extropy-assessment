import { randomUUID } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogContext = Record<string, unknown>;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const currentLevel = (): LogLevel => {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return (['debug', 'info', 'warn', 'error'] as const).includes(raw as LogLevel)
    ? (raw as LogLevel)
    : 'info';
};

let seq = 0;

/**
 * Emit one JSON line per event. CloudWatch parses JSON automatically, enabling
 * Logs Insights queries like `filter event = "chat.completed" | stats avg(latencyMs)`.
 * OTel Collectors ingest the same shape via the fluentbit → OTLP pipeline.
 *
 * `seq` catches log reordering during high-throughput flushes; `ts` is
 * server-wallclock for post-hoc trace assembly.
 */
export const log = (level: LogLevel, event: string, ctx: LogContext = {}): void => {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
  seq += 1;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, seq, ...ctx });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
};

export type TracedLogger = {
  traceId: string;
  debug: (event: string, ctx?: LogContext) => void;
  info: (event: string, ctx?: LogContext) => void;
  warn: (event: string, ctx?: LogContext) => void;
  error: (event: string, ctx?: LogContext) => void;
  child: (ctx: LogContext) => TracedLogger;
};

/** Build a logger bound to a trace id and inherited context. */
export const withTrace = (traceId: string, base: LogContext = {}): TracedLogger => {
  const bind =
    (level: LogLevel) =>
    (event: string, ctx: LogContext = {}) =>
      log(level, event, { traceId, ...base, ...ctx });
  return {
    traceId,
    debug: bind('debug'),
    info: bind('info'),
    warn: bind('warn'),
    error: bind('error'),
    child: (ctx) => withTrace(traceId, { ...base, ...ctx }),
  };
};

export const newTraceId = (): string => randomUUID();
