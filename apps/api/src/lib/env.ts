import { z } from 'zod';

// Deployment environments (e.g. Lambda) often inject a variable as an empty
// string rather than omitting it. Zod's `.optional()` only accepts `undefined`,
// so an empty string would slip past it and fail the inner check (`.min(1)`,
// `.startsWith(...)`, `.url()`). Coerce '' → undefined so optional means optional
// regardless of how the value was (not) provided.
const optional = (schema: z.ZodTypeAny) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

// Like `optional` but supplies a default when the value is absent or empty.
// Keeps the '' → undefined coercion so a Lambda-injected empty string falls
// through to the default rather than tripping the inner `.min(1)` check.
const withDefault = (schema: z.ZodTypeAny, fallback: string) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.default(fallback));

const envSchema = z.object({
  MONGODB_URI: z.string().startsWith('mongodb'),
  MONGODB_DB: z.string().min(1).default('blog'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  OPENROUTER_API_KEY: optional(z.string().startsWith('sk-or-')),
  OPENROUTER_MODEL: withDefault(z.string().min(1), 'anthropic/claude-sonnet-4.5'),
  OPENROUTER_FALLBACK_MODEL: withDefault(z.string().min(1), 'anthropic/claude-haiku-4.5'),
  CORS_ALLOWED_ORIGIN: z.string().default('*'),
  EMBEDDING_API_KEY: optional(z.string().min(1)),
  EMBEDDING_BASE_URL: optional(z.string().url()),
  EMBEDDING_MODEL: optional(z.string().min(1)),
  CHAT_RETRIEVAL_K: z.coerce.number().int().positive().max(20).default(5),
  CHAT_HISTORY_TOKEN_BUDGET: z.coerce.number().int().positive().default(6000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

let cached: z.infer<typeof envSchema> | undefined;

export const env = () => {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
};
