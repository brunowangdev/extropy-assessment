# Blog Platform — a small blog with a big brain

A fullstack blogging platform (Option 3) with a Claude-powered chat assistant (AI Option A) grounded in each user's own data. Built for the Extropy home assessment.

- **GitHub:** https://github.com/brunowangdev/extropy-assessment
- **Live app:** https://d3of4v61ri8rjm.cloudfront.net/

---

## What's here

- **Author/Reader roles.** Authors write and manage Markdown posts (drafts + published). Readers browse the public feed with pagination.
- **Tags** on every post. Editor has a tag input with validation; feed shows the most-used tags across the site; clicking a tag filters the feed.
- **Full-text search** over published posts, powered by MongoDB's built-in text index on `title` (5×) + `content` (1×). Debounced input on the home page.
- **Author profiles** at `/authors/:id` — display name, join date, published post count, five most-recent published posts. Author names in the feed link into their profile.
- **AI assistant** (`/chat`) that answers natural-language questions about the posts visible to the current user — and, for authors, **acts on their behalf**: create, edit, and delete their own posts through natural language. Streaming SSE responses, function-calling tool use for on-demand full-post fetches and post mutations, graceful fallback when the API is unavailable.
- **MongoDB** — Atlas in production, local Docker in dev. Schemaless documents, indexes created idempotently by `pnpm migrate`.
- **Deployed to AWS** via CDK: API Gateway HTTP API + Lambda for REST, Lambda Function URL (RESPONSE_STREAM) for chat, S3 + CloudFront for the SPA. No VPC or RDS since MongoDB Atlas is external.

---

## Architecture

```
Browser ─► CloudFront + S3 (SPA)
             │
             ├─► API Gateway HTTP API  ──►  Lambda (REST: auth, posts,   ──►  MongoDB Atlas
             │                                     tags, authors, me)
             │
             └─► Lambda Function URL   ──►  Lambda (SSE chat streaming)  ──►  OpenRouter API
                 (RESPONSE_STREAM)          ──►  MongoDB Atlas (context)
```

- **Two request paths on purpose.** API Gateway HTTP API doesn't support Lambda response streaming, so the chat endpoint gets its own Function URL. Both endpoints validate the same JWT via a shared middleware, so from the client's perspective they're one auth boundary.
- **MongoDB Atlas is external to AWS.** No VPC, no NAT Gateway, no RDS — Lambda reaches it over the internet with the URI as an SSM-stored secret. Simpler and cheaper than the RDS path.
- **Frontend build is baked with API URLs.** Two-phase deploy: `cdk deploy` provisions infra, we read the outputs, write them into the repo-root `.env.production` (Vite's `envDir` points at the repo root), build the frontend, then `cdk deploy` again to upload assets.

### AI assistant design

**LLM provider — OpenRouter.** Backend calls the OpenAI-compatible chat completions API at `https://openrouter.ai/api/v1`. This lets us swap between Claude, GPT, Llama, and other models by changing a single env var (`OPENROUTER_MODEL`) without touching code. Default model: `anthropic/claude-sonnet-4.5`. Cheaper fallback: `anthropic/claude-haiku-4.5`.

**Retrieval (RAG).** Posts are chunked (sentence-boundary, ~200-token target with ~40-token overlap) at write time, embedded via any OpenAI-compatible endpoint (`text-embedding-3-small` by default), and stored in a `post_chunks` collection. Each chat turn re-retrieves against the latest user question — cheaper than caching, keeps recall aligned. Retrieval is **hybrid**: dense cosine top-K + MongoDB text-index top-K, combined via **Reciprocal Rank Fusion** (RRF with the standard k=60). This gives semantic recall plus keyword precision without a second LLM rerank round-trip. See [apps/api/src/services/rag.ts](apps/api/src/services/rag.ts).

**Fully degrades**: when `EMBEDDING_API_KEY` is unset, retrieval is lexical-only. When the text index is unavailable too, the chat still runs on an empty context and the model is instructed to say so — no crashes at any layer.

**Sliding-window history.** Prior conversation turns are token-budgeted (`CHAT_HISTORY_TOKEN_BUDGET`, default 6000) via char-based estimator (real tokenizers cost ~3MB WASM in Lambda cold-start — see [apps/api/src/lib/tokens.ts](apps/api/src/lib/tokens.ts)). Oldest turns get dropped first; the newest user turn is always retained.

**Tool use** — the model calls tools in the OpenAI function-calling format. **Arguments are Zod-validated** before execution — malformed JSON, non-UUID ids, or bad field values surface to the model as structured errors, not crashes. Up to `MAX_TOOL_ROUNDS = 3` round-trips before the final round forces `tool_choice: 'none'` to guarantee termination.

- **`get_post(id)`** *(all users)* — fetch a post's full body. The service enforces the same visibility rules that gated retrieval.
- **`create_post` / `update_post` / `delete_post`** *(authors only)* — the assistant can manage the author's own posts. These reuse the exact same service functions as the REST API, so they inherit **ownership enforcement** (you can only touch your own posts), **input validation** (shared Zod schemas), and **automatic RAG re-indexing** on every write.

**Authoring safety.** Write tools are gated three ways: they're only *offered* to authors (`buildTools(role)`), the executor **re-checks the role** as defense-in-depth in case the model emits a call anyway, and the underlying service enforces per-post ownership (a 403 becomes a structured tool error the model relays). The system prompt instructs the model to confirm content and intent with the user before mutating — and to get an explicit yes before the irreversible `delete_post`. Posts are created as **drafts by default**; publishing requires an explicit ask. See [apps/api/src/services/chat.ts](apps/api/src/services/chat.ts).

**Streaming** — `openai` SDK's async iterator over `chat.completions.create({stream: true})`, forwarded as SSE (`text/event-stream`) frames to the browser. Tool-call arguments arrive as JSON fragments spread across chunks — accumulated by `consumeStream` before execution. Frontend uses `fetch()` + `ReadableStream` (not `EventSource`, because we need to POST a body).

**CORS on the Function URL is owned by the handler**, not the Function URL's native CORS (which would double-stamp `Access-Control-Allow-Origin` on streamed responses). The handler echoes the exact request origin and answers the `OPTIONS` preflight itself. One subtlety of response streaming: `HttpResponseStream.from()` only flushes its status+headers prelude once the stream is *written to*, so the preflight branch writes a byte before ending — a zero-byte `end()` drops the CORS headers and the browser rejects the preflight. See [apps/api/src/handlers/chat.ts](apps/api/src/handlers/chat.ts).

### Production resilience

Every OpenRouter/embedding call goes through [`withRetry`](apps/api/src/lib/retry.ts):

- **3 attempts** with exponential backoff + full jitter.
- **Per-attempt timeout** (20s connect / 45s idle) via a fresh `AbortController`.
- **Terminal error short-circuit**: 4xx (except 408/429) never retries.
- **Model fallback**: if the primary model fails cold, retry once with `OPENROUTER_FALLBACK_MODEL` — but only before any tokens have been streamed to the client (a mid-stream swap would produce a Frankenstein response).
- **Mid-stream failures** emit `{type:"error"}` and close cleanly.
- **Authentication and validation happen BEFORE opening the SSE stream** — 401/400 are real HTTP statuses with `X-Trace-Id`, not `200 OK` with an inline error frame.

### LLM observability & evaluation

All service events emit **structured JSON logs** ([apps/api/src/lib/logger.ts](apps/api/src/lib/logger.ts)) with:

- `traceId` correlation across the request lifecycle (`X-Trace-Id` is echoed in every response header).
- `event` name (`chat.started`, `chat.tool.executed`, `chat.completed`, `rag.retrieved`, etc.).
- `usage.prompt_tokens` / `completion_tokens` — pulled from provider's `stream_options.include_usage`, falling back to the char-based estimator when the provider withholds it.
- `usd` cost — via a per-1M-token pricing table in [apps/api/src/lib/tokens.ts](apps/api/src/lib/tokens.ts) that is refreshed at release time (no per-call metadata fetches).
- `latencyMs`, `rounds`, `finishReason`, `historyDropped`, `retrievalHits` — everything you'd want on a dashboard.

CloudWatch Logs Insights ingests JSON natively (`filter event = "chat.completed" | stats avg(latencyMs), sum(usd)`). The same shape flows into OpenTelemetry/LangFuse via a Logs → OTLP collector — no vendor-specific SDK required.

**Prompt evaluation** — [apps/api/src/services/chat.eval.test.ts](apps/api/src/services/chat.eval.test.ts) mocks the OpenAI client and asserts on the exact prompt shape the model receives (grounding rules present, only retrieved ids visible, latest-user-turn drives retrieval), plus tool-call safety (Zod rejection surfaces as a structured error to the model, unparseable JSON returns a retry hint). The authoring tools get their own coverage: write tools are offered only to authors, a reader's emitted mutation is refused, successful create/update/delete calls are marshalled into the service and their results relayed back to the model, and ownership/validation errors round-trip as structured tool errors. When you graduate to full evals (Braintrust, promptfoo, LangSmith), these fixtures become the input generator.

---

## Repo layout

```
apps/
  api/          Lambda handlers + services + local dev server
  web/          React + Vite + Tailwind + shadcn/ui SPA
packages/
  shared/       Zod schemas + types shared by client and server
infra/          AWS CDK app (TypeScript)
```

---

## Prerequisites

- **Node.js** 20.x
- **pnpm** ≥ 9.0
- **MongoDB** — either Docker (`mongo:7`) for local dev or a free **MongoDB Atlas M0 cluster** for production
- **AWS CLI** configured (`aws configure`) and **CDK bootstrapped** in your target region (`cdk bootstrap`) — see [Getting AWS credentials](#getting-aws-credentials) below
- **OpenRouter API key** (for the chat feature) — get one at https://openrouter.ai/keys. Keys start with `sk-or-`. OpenRouter is a unified gateway to Claude, GPT, Llama, and other models — the code uses `anthropic/claude-sonnet-4.5` by default, swappable via `OPENROUTER_MODEL`.

---

## Setup

```powershell
# 1. Install
pnpm install

# 2. Copy env template and fill it in
Copy-Item .env.example .env
# Edit .env — see notes on each variable below.

# 3. Start local MongoDB (or use MongoDB Atlas — see below)
docker run -d --name blog-mongo -p 27017:27017 mongo:7

# 4. Create indexes
pnpm --filter @blog/api migrate

# 5. Run frontend + API in parallel
pnpm run dev
```

Open http://localhost:5173. The API runs on http://localhost:3000.

### MongoDB — local vs Atlas

Both are supported. Pick one:

- **Local Docker** (fastest for dev): `docker run -d --name blog-mongo -p 27017:27017 mongo:7`, then `MONGODB_URI=mongodb://localhost:27017` in `.env`.
- **MongoDB Atlas** (used in production):
  1. Sign up at https://cloud.mongodb.com and create a **free M0 cluster**.
  2. Create a database user (Database Access → Add New Database User).
  3. Allow your IP under Network Access (or `0.0.0.0/0` for dev).
  4. Click **Connect → Drivers**, copy the `mongodb+srv://...` string. Put your password in and set it as `MONGODB_URI` in `.env`.

Either way, run `pnpm --filter @blog/api migrate` once to create indexes (unique email, author/updated compound, published/publishedAt, tags, and a text index on title+content).

### Environment variables

`.env` at the repo root — loaded by the API dev server and the CDK deploy script. The `.env` template is [`.env.example`](.env.example), which lists every variable below.

A second file, `.env.production` (repo root), is **generated by the deploy script** and holds only the two frontend `VITE_*` vars (`VITE_API_URL`, `VITE_CHAT_URL`) so the production build points at the deployed API instead of `localhost`. The backend/infra variables are never written there — in production the Lambdas read secrets from SSM Parameter Store and the rest from their configured environment.

| Variable | Where | Notes |
|---|---|---|
| `MONGODB_URI` | api | Connection string. `mongodb://localhost:27017` locally; `mongodb+srv://...` for Atlas. |
| `MONGODB_DB` | api | Database name inside the cluster. Defaults to `blog`. |
| `JWT_SECRET` | api | 32+ chars. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `OPENROUTER_API_KEY` | api | Required for `/chat`. If missing, chat returns 503. |
| `OPENROUTER_MODEL` | api | Optional. Defaults to `anthropic/claude-sonnet-4.5`. Any OpenRouter-supported model id works. |
| `OPENROUTER_FALLBACK_MODEL` | api | Optional. Cheaper/faster model used only on a cold-start failure of the primary (never mid-stream). Defaults to `anthropic/claude-haiku-4.5`. |
| `EMBEDDING_API_KEY` | api | Optional. OpenAI-compatible embeddings key for RAG. When unset, retrieval falls back to lexical-only (no crash). |
| `EMBEDDING_BASE_URL` | api | Optional. Embedding endpoint base URL. Defaults to `https://api.openai.com/v1` (point at Ollama/vLLM to self-host). |
| `EMBEDDING_MODEL` | api | Optional. Embedding model id. Defaults to `text-embedding-3-small`. |
| `CHAT_RETRIEVAL_K` | api | Optional. Chunks retrieved for grounding per turn (1–20). Defaults to `5`. |
| `CHAT_HISTORY_TOKEN_BUDGET` | api | Optional. Token budget for prior-turn history after the system prompt is subtracted. Defaults to `6000`. |
| `LOG_LEVEL` | api | Optional. Structured-log verbosity: `debug` \| `info` \| `warn` \| `error`. Defaults to `info`. |
| `CORS_ALLOWED_ORIGIN` | api | `http://localhost:5173` locally; set to CloudFront domain in production. Comma-separated to allow multiple origins. |
| `VITE_API_URL` | web | Base URL of the REST API. |
| `VITE_CHAT_URL` | web | Full URL of the chat Function URL (or `http://localhost:3000/chat` locally). |
| `AWS_REGION` | infra | Optional, defaults to `us-east-1`. |

**Fail-fast validation:** the API validates its env with Zod on cold start and throws a clear error listing the offending variables if anything is missing or malformed.

---

## Running locally

```bash
pnpm run dev
```

This starts:
- API on http://localhost:3000 (the `apps/api/src/dev-server.ts` adapter routes Node HTTP requests to the same handler shape used in Lambda)
- Frontend on http://localhost:5173

**Manual smoke flow:**
1. Sign up as an author.
2. Create a draft post, then publish it.
3. Log out, sign up as a reader.
4. Verify the reader can see the published post but not the draft.
5. Open `/chat`, ask _"What posts are on this blog?"_ — verify streaming.

---

## Testing / linting / type checking

```bash
pnpm test        # Vitest across packages
pnpm typecheck   # tsc --noEmit across packages
pnpm lint        # eslint --fix disabled by default; run `pnpm -r lint -- --fix`
```

The critical-paths tests cover:
- Password hashing round-trip + bad password rejection (`apps/api/src/lib/auth.test.ts`)
- JWT sign/verify + tampering (`apps/api/src/lib/auth.test.ts`)
- Error shape mapping (`apps/api/src/lib/errors.test.ts`)
- `cn()` utility (`apps/web/src/lib/utils.test.ts`)

Authorization rules are enforced at the service layer, so unit tests could plug into `posts.service` directly with a test MongoDB (e.g. `mongodb-memory-server`) — deliberately not shipped in v1 to stay within the time budget.

---

## Getting AWS credentials

If you don't have AWS access yet:

1. **Create an AWS account** at https://aws.amazon.com/. You'll need a credit card, but the free tier covers everything in this stack for 12 months (see the [free-tier caveat](#trade-offs)).
2. **Install the AWS CLI**: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html
3. **Create an IAM user with programmatic access.** The console is the fastest path:
   - Sign in to https://console.aws.amazon.com/ and open **IAM** → **Users** → **Create user**.
   - Give it a name (e.g. `ink-deploy`) and skip console access.
   - On the **Set permissions** step, choose **Attach policies directly** and select **`AdministratorAccess`**. CDK needs to create IAM roles, Lambda functions, API Gateway, S3, CloudFront, SSM parameters — a scoped policy would work but writing it correctly is more work than the assessment is worth. Delete the user when you're done to reduce blast radius.
   - After creating the user, open it → **Security credentials** → **Create access key** → choose **Command Line Interface (CLI)** → confirm.
   - **Copy the Access Key ID and Secret Access Key.** You'll only see the secret once.
4. **Configure the CLI:**
   ```bash
   aws configure
   # AWS Access Key ID: <paste>
   # AWS Secret Access Key: <paste>
   # Default region name: us-east-1
   # Default output format: json
   ```
5. **Verify:**
   ```bash
   aws sts get-caller-identity
   ```
   You should see your account id and the IAM user's ARN.
6. **Bootstrap CDK** in that account/region (once per account+region):
   ```bash
   cd infra && pnpm cdk bootstrap && cd ..
   ```

> **Cost reminder.** The stack sits inside the 12-month AWS free tier as long as you stay under the limits (1M Lambda requests/mo, 1TB CloudFront egress/mo, 5GB S3, 1M API Gateway calls/mo). MongoDB Atlas M0 is **free forever** — no 12-month clock. There's no RDS cost since the database is external. **When you're done reviewing, tear the AWS side down with `cd infra && pnpm cdk destroy`.**

## Deploying to AWS

Once the credentials + bootstrap steps above are done:

```powershell
# 1. Make sure MONGODB_URI in .env points to your Atlas cluster (not localhost).

# 2. Deploy — two-phase, coordinated by scripts/deploy.ts
pnpm run deploy

# 3. Create indexes on your Atlas cluster (once). Uses the same MONGODB_URI as .env.
pnpm --filter @blog/api migrate
```

The deploy script:
1. Runs `cdk deploy` and captures `ApiUrl` + `ChatUrl` from the stack outputs.
2. Writes the repo-root `.env.production` with those values (Vite reads env files from the repo root via `envDir`).
3. Builds the frontend.
4. Runs `cdk deploy` again — this time `BucketDeployment` uploads the built assets and invalidates CloudFront.

Because the frontend needs the API URLs baked into its bundle at build time, this two-phase dance is unavoidable without adding runtime config-fetching (which was cut for scope; see [Trade-offs](#trade-offs)).

**Tearing down:**

```bash
cd infra && pnpm cdk destroy
```

---

## Trade-offs

Deliberate calls made to fit the 20–30h assessment window on the AWS free tier.

- **MongoDB Atlas over RDS.** The Option 3 spec calls for MongoDB Atlas or DynamoDB specifically. Atlas is external to AWS, which means no VPC, no NAT Gateway ($32+/mo saved), no RDS Proxy — Lambda talks to Atlas over the internet with TLS. The M0 free tier is generous (512MB) and doesn't expire after 12 months like RDS does.
- **Denormalized `authorName` on posts.** Feeds don't need a join to render the author's display name. Trade-off: if a user changes their display name, existing posts still show the old one until they edit or repost. Acceptable at this scale; would fix with a change-stream listener or a background job in a bigger system.
- **OpenRouter as an LLM gateway, not a direct Anthropic/OpenAI call.** OpenRouter is OpenAI-API-compatible and lets us swap models via env var (`OPENROUTER_MODEL`) without changing code. It adds a small routing markup, but the flexibility beats vendor lock-in.
- **Prompt-level confirmation for post mutations, not a hard server gate.** The authoring tools (`create_post`/`update_post`/`delete_post`) execute as soon as the model calls them; "confirm with the user first" is enforced by the system prompt, not a two-step handshake. Ownership and validation are always enforced server-side, so the worst case is an author's own post changing without an explicit final "yes" — recoverable for create/edit, but not for delete. Production upgrade: a stateful confirm step where a mutation returns a preview token and only a second call bearing that token commits (belt-and-suspenders for the irreversible delete).
- **Full-text search via MongoDB's built-in text index.** Weighted (title 5×, content 1×), no extra service. Not as good as Atlas Search or a dedicated engine (no fuzzy, no synonyms), but the setup is zero and it satisfies the "post search" enhancement cleanly.
- **In-memory cosine over stored embeddings, not Atlas Vector Search.** Simplifies local dev (works against Docker Mongo) and avoids the Atlas Search Admin API for programmatic index creation. Fine at assessment scale (~O(chunks × dim), tens of ms for hundreds of posts). Production path: swap the vector-topK loop for an Atlas `$vectorSearch` aggregation stage — same interface.
- **Inline post indexing, not async.** Post create/update awaits the embedding call before returning. Adds ~200–500 ms to the write path but guarantees the index is coherent when the next chat turn runs. Production upgrade: SQS + worker Lambda, or Atlas Triggers with change streams.
- **Char-based token estimator, not a real tokenizer.** Real tokenizers (tiktoken) ship WASM binaries that add 2–3MB to the Lambda cold-start. Char count divided by 4 (rounded up) is within ~15% for English prose and is used only for budget accounting, never billing.
- **Two-phase deploy.** The frontend needs API URLs at build time. First `cdk deploy` provisions infra, second uploads built assets. Alternative would be a runtime `/config.json` fetched by the SPA, adding a network hop on first paint.
- **No custom domain / ACM.** Raw CloudFront + API Gateway URLs. ACM + Route 53 add complexity without changing the review.
- **SSM Parameter Store, not Secrets Manager.** Free tier. Rotation would be manual — acceptable for the JWT + OpenRouter key at this scale.
- **Native `mongodb` driver, not Mongoose.** Zero schema layer in the app, lower cold-start weight, less indirection. Zod already validates at the API boundary, so a runtime schema layer would be duplicated work.
- **Auth token in Zustand + localStorage.** CloudFront and API Gateway live on different origins, so httpOnly cookies would require CORS + SameSite gymnastics. localStorage is XSS-vulnerable, mitigated by input sanitization and `rehype-sanitize` on rendered Markdown. Migrating to httpOnly cookies + a custom domain covering both origins is the production upgrade path.
- **`bcryptjs`, not `bcrypt`.** Pure-JS, no native compile in the monorepo. Cost factor 10 for a login-latency-friendly hash on Lambda ARM64.
- **No pagination cursors, just offset.** Fine for a blog with tens or hundreds of posts. Would want keyset pagination in production.

---

## Things I'd do with more time

- **Atlas Vector Search** — replace the in-memory cosine scan with a native `$vectorSearch` aggregation stage. Needed once the corpus grows past a few thousand chunks.
- **Async re-indexing via SQS + worker Lambda** — decouple embedding from the post-write hot path. Adds durable retry + backpressure.
- **Cross-encoder reranker** on the top-20 fused candidates before keeping top-5. Small model (bge-reranker-base) via HuggingFace TGI or a hosted API — measurable quality bump when the query is ambiguous.
- **Session-scoped rate limiting** on `/chat` at the Lambda authorizer layer, to prevent a signed-in user from running up the OpenRouter bill. Redis/DynamoDB-backed sliding-window counter keyed by `userId`.
- **CloudWatch dashboard + alarms** for `chat.completed` p95 latency, `chat.error` rate, `usd` cost per hour, and Atlas connection saturation. Structured logs are already in the right shape — just needs the metric filters + Grafana pane.
- **Real tokenizer** (tiktoken or model-specific) — accepting the WASM cold-start hit once we care about budget accuracy in the low single digits of tokens.
- **Full LLM eval harness** — promptfoo or Braintrust with a scored corpus. The mocked fixtures in `chat.eval.test.ts` are the input side of that pipeline; graduation needs the grading side (LLM-as-judge or human ratings).
- **Persistent chat sessions** — right now conversations live only in React state and vanish on reload; each `/chat` request re-sends the full history from the client. A `chat_sessions` collection (keyed by `userId`, with a `messages` array + `createdAt`/`updatedAt`) would let users resume past conversations, give the assistant durable long-term memory across visits, and back a sidebar of prior threads. Server-side persistence also enables per-session analytics (turns, cost, tool usage) and trimming history server-side instead of trusting the client payload.
- **Streaming input to the assistant** — currently the whole user message must be sent before the model starts responding. Turn-by-turn tool feedback in the UI (right now we surface only the first tool call's name).
- **E2E tests** with Playwright, running against a spun-up local stack.

---

## References

- Assessment brief: `Home assessment.pdf` in the repo root.
- OpenRouter API: https://openrouter.ai/docs
- OpenAI function calling (the format OpenRouter accepts): https://platform.openai.com/docs/guides/function-calling
- AWS Lambda response streaming: https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html
