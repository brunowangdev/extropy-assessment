import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { z } from 'zod';
import {
  createPostSchema,
  updatePostSchema,
  type ChatMessage,
  type ChatStreamFrame,
  type Role,
} from '@blog/shared';
import { posts as postsCol } from '../lib/db.js';
import { env } from '../lib/env.js';
import { AppError, serviceUnavailable } from '../lib/errors.js';
import type { TracedLogger } from '../lib/logger.js';
import { withRetry } from '../lib/retry.js';
import { applySlidingWindow, estimateCost, estimateTokens } from '../lib/tokens.js';
import { createPost, deletePost, updatePost } from './posts.js';
import { retrieveChunks, type RetrievedChunk } from './rag.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MAX_TOKENS_OUT = 1024;
const MAX_TOOL_ROUNDS = 3;
const CONNECT_TIMEOUT_MS = 20_000;
const STREAM_IDLE_TIMEOUT_MS = 45_000;

const getPostToolSchema = z.object({ id: z.string().uuid() });
// `update_post` reuses the shared partial-update schema, plus a required id.
const updatePostToolSchema = updatePostSchema.extend({ id: z.string().uuid() });
const deletePostToolSchema = z.object({ id: z.string().uuid() });

/** Read tools are available to every user. */
const READ_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_post',
      description:
        'Fetch the full markdown body of a post by id. Only works for posts the user can see (published, or their own drafts if they are the author).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Post UUID from the retrieved context.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
];

/**
 * Write tools mutate the author's own posts. They are only offered to authors
 * (see `buildTools`); `executeTool` re-checks the role as defense in depth, and
 * the underlying services enforce per-post ownership.
 */
const WRITE_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'create_post',
      description:
        "Create a new blog post owned by the current author. Creates a DRAFT by default (published=false); only set published=true when the user explicitly asks to publish. Confirm the title and content with the user before calling.",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Post title, 1–200 characters.' },
          content: { type: 'string', description: 'Full post body in Markdown, 1–50000 characters.' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags, max 8. Lowercase letters, digits, and hyphens only.',
          },
          published: {
            type: 'boolean',
            description: 'Publish immediately? Defaults to false (save as draft).',
          },
        },
        required: ['title', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_post',
      description:
        "Edit one of the current author's existing posts by id. Only works for posts they own. Supply only the fields to change; omitted fields are left untouched. Setting published=true publishes a draft. Use an id from the retrieved context or a prior get_post/create_post result — never guess ids. Confirm the changes with the user before calling.",
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            format: 'uuid',
            description: 'UUID of the post to edit (from context or a prior tool result).',
          },
          title: { type: 'string', description: 'New title, 1–200 characters.' },
          content: { type: 'string', description: 'New full Markdown body, 1–50000 characters.' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Replacement tag list, max 8. Lowercase letters, digits, and hyphens only.',
          },
          published: { type: 'boolean', description: 'Set true to publish, false to unpublish.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_post',
      description:
        "Permanently delete one of the current author's own posts by id. This cannot be undone. Only call after the user has explicitly confirmed they want the post deleted. Use an id from the retrieved context or a prior tool result — never guess ids.",
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            format: 'uuid',
            description: 'UUID of the post to delete (from context or a prior tool result).',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
];

/** Readers get read-only tools; authors additionally get post-mutation tools. */
const buildTools = (role: Role): ChatCompletionTool[] =>
  role === 'author' ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;

const formatContext = (chunks: RetrievedChunk[]): string => {
  if (chunks.length === 0) return '(no relevant posts found)';
  return chunks
    .map((c, i) => {
      const date = c.publishedAt ? c.publishedAt.toISOString().slice(0, 10) : 'draft';
      return `[chunk ${i + 1}] post_id=${c.postId} | date=${date} | title="${c.title}"\n${c.text}`;
    })
    .join('\n\n');
};

const buildSystemPrompt = (role: Role, displayName: string, context: string): string => {
  const audience =
    role === 'author'
      ? `You are helping ${displayName}, an author on this blog platform. They can ask about their own posts — drafts and published — such as themes, gaps in coverage, editing suggestions, or summaries. You can also create new posts and edit their existing posts on their behalf.`
      : `You are helping ${displayName}, a reader on this blog platform. They can ask about the published posts on the site — recommendations, summaries, what's covered, who writes about what.`;

  const authoring =
    role === 'author'
      ? `
Authoring rules (you have create_post, update_post, and delete_post tools):
- Only act when ${displayName} clearly asks you to create, change, or delete a post. Never mutate posts on your own initiative.
- Before calling create_post or update_post, confirm the title, content, and whether to publish. Draft the content and show it, then call the tool once they approve.
- Create posts as drafts (published=false) unless the user explicitly says to publish.
- For update_post, change only the fields the user asked about; pass an id from the retrieved context or a prior get_post/create_post result — never guess ids. You can only edit ${displayName}'s own posts.
- delete_post is permanent and cannot be undone. Always confirm the exact post (by title and id) with the user and get an explicit yes before calling it. You can only delete ${displayName}'s own posts.
- After a successful mutation, briefly confirm what changed and include the post id.`
      : '';

  return `You are a concise, helpful assistant embedded in a personal blog platform.

${audience}

Grounding rules:
- Answer only from the retrieved context below. If the answer isn't there, say so — do not invent post ids, titles, or content.
- To read a post's full body, call the get_post tool with an id from the context. Never guess ids.
- Prefer short, direct answers. Use bullets when listing.
- If context is empty, tell the user kindly and offer to help another way.
${authoring}

Retrieved context (top matches for the user's current question):
${context}
`;
};

const getFullPostBody = async (
  postId: string,
  userId: string,
  role: Role,
): Promise<string> => {
  const col = await postsCol();
  const doc = await col.findOne(
    { _id: postId },
    { projection: { content: 1, published: 1, authorId: 1 } },
  );
  if (!doc) return 'Error: post not found.';
  if (!doc.published && (role !== 'author' || doc.authorId !== userId)) {
    return 'Error: post not accessible.';
  }
  return doc.content;
};

type AccumulatedToolCall = { id: string; name: string; args: string };

type StreamConsumption = {
  toolCalls: AccumulatedToolCall[];
  assistantText: string;
  finishReason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | undefined;
};

/**
 * Consume one streaming completion. Tool-call arguments arrive as JSON
 * fragments spread across chunks — we accumulate by `index` (the OpenAI
 * spec's stable per-call identifier within a response). `usage` on the final
 * chunk requires `stream_options.include_usage: true` at request time;
 * providers that ignore that flag simply return no usage and we fall back to
 * an estimator downstream.
 */
const consumeStream = async (
  stream: AsyncIterable<ChatCompletionChunk>,
  emit: (frame: ChatStreamFrame) => void,
  logger: TracedLogger,
): Promise<StreamConsumption> => {
  const toolAcc = new Map<number, AccumulatedToolCall>();
  let assistantText = '';
  let finishReason: string | null = null;
  let usage: StreamConsumption['usage'];

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (choice) {
      const delta = choice.delta ?? {};

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        assistantText += delta.content;
        emit({ type: 'text', value: delta.content });
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const prev = toolAcc.get(tc.index) ?? { id: '', name: '', args: '' };
          toolAcc.set(tc.index, {
            id: tc.id ?? prev.id,
            name: tc.function?.name ?? prev.name,
            args: prev.args + (tc.function?.arguments ?? ''),
          });
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const chunkUsage = (chunk as ChatCompletionChunk & { usage?: StreamConsumption['usage'] }).usage;
    if (chunkUsage) usage = chunkUsage;
  }

  logger.debug('chat.stream.consumed', {
    finishReason,
    toolCalls: toolAcc.size,
    textChars: assistantText.length,
    hasUsage: usage !== undefined,
  });

  return { toolCalls: Array.from(toolAcc.values()), assistantText, finishReason, usage };
};

const formatZodIssues = (issues: z.ZodIssue[]): string =>
  `Error: invalid arguments — ${issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;

const runGetPost = async (
  raw: unknown,
  userId: string,
  role: Role,
  logger: TracedLogger,
): Promise<string> => {
  const parsed = getPostToolSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn('chat.tool.args.invalid', { name: 'get_post' });
    return formatZodIssues(parsed.error.issues);
  }
  const body = await getFullPostBody(parsed.data.id, userId, role);
  logger.info('chat.tool.executed', { name: 'get_post', postId: parsed.data.id, resultChars: body.length });
  return body;
};

const runCreatePost = async (
  raw: unknown,
  userId: string,
  role: Role,
  logger: TracedLogger,
): Promise<string> => {
  // Defense in depth: authors-only. The tool isn't offered to readers, but a
  // model could still emit the call, so we refuse rather than trust the schema.
  if (role !== 'author') return 'Error: only authors can create posts.';
  const parsed = createPostSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn('chat.tool.args.invalid', { name: 'create_post' });
    return formatZodIssues(parsed.error.issues);
  }
  try {
    const post = await createPost(userId, parsed.data, logger);
    logger.info('chat.tool.executed', { name: 'create_post', postId: post.id, published: post.published });
    return `Created ${post.published ? 'and published' : 'draft'} post "${post.title}" with id ${post.id}${
      post.published ? '.' : ' (not yet published).'
    }`;
  } catch (err) {
    const message = err instanceof AppError ? err.message : 'failed to create the post';
    logger.warn('chat.tool.create_post.failed', { error: message });
    return `Error: ${message}.`;
  }
};

const runUpdatePost = async (
  raw: unknown,
  userId: string,
  role: Role,
  logger: TracedLogger,
): Promise<string> => {
  if (role !== 'author') return 'Error: only authors can edit posts.';
  const parsed = updatePostToolSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn('chat.tool.args.invalid', { name: 'update_post' });
    return formatZodIssues(parsed.error.issues);
  }
  const { id, ...fields } = parsed.data;
  if (Object.keys(fields).length === 0) {
    return 'Error: no fields to update — provide at least one of title, content, tags, or published.';
  }
  try {
    // updatePost enforces ownership (403 if the post isn't the author's).
    const post = await updatePost(id, userId, fields, logger);
    logger.info('chat.tool.executed', { name: 'update_post', postId: post.id, published: post.published });
    return `Updated post "${post.title}" (id ${post.id}). It is now ${
      post.published ? 'published' : 'a draft'
    }.`;
  } catch (err) {
    const message = err instanceof AppError ? err.message : 'failed to update the post';
    logger.warn('chat.tool.update_post.failed', { postId: id, error: message });
    return `Error: ${message}.`;
  }
};

const runDeletePost = async (
  raw: unknown,
  userId: string,
  role: Role,
  logger: TracedLogger,
): Promise<string> => {
  if (role !== 'author') return 'Error: only authors can delete posts.';
  const parsed = deletePostToolSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn('chat.tool.args.invalid', { name: 'delete_post' });
    return formatZodIssues(parsed.error.issues);
  }
  try {
    // deletePost enforces ownership (403) and removes the post from the index.
    await deletePost(parsed.data.id, userId, logger);
    logger.info('chat.tool.executed', { name: 'delete_post', postId: parsed.data.id });
    return `Deleted post ${parsed.data.id}. This cannot be undone.`;
  } catch (err) {
    const message = err instanceof AppError ? err.message : 'failed to delete the post';
    logger.warn('chat.tool.delete_post.failed', { postId: parsed.data.id, error: message });
    return `Error: ${message}.`;
  }
};

const executeTool = async (
  call: AccumulatedToolCall,
  userId: string,
  role: Role,
  logger: TracedLogger,
): Promise<string> => {
  let raw: unknown;
  try {
    raw = JSON.parse(call.args);
  } catch {
    logger.warn('chat.tool.args.unparseable', {
      name: call.name,
      argsPreview: call.args.slice(0, 120),
    });
    return 'Error: tool arguments were not valid JSON. Retry with a single JSON object.';
  }

  switch (call.name) {
    case 'get_post':
      return runGetPost(raw, userId, role, logger);
    case 'create_post':
      return runCreatePost(raw, userId, role, logger);
    case 'update_post':
      return runUpdatePost(raw, userId, role, logger);
    case 'delete_post':
      return runDeletePost(raw, userId, role, logger);
    default:
      logger.warn('chat.tool.unknown', { name: call.name });
      return `Unknown tool: ${call.name}.`;
  }
};

export type StreamContext = {
  userId: string;
  role: Role;
  displayName: string;
  messages: ChatMessage[];
  logger: TracedLogger;
};

const buildClient = (apiKey: string) =>
  new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    timeout: STREAM_IDLE_TIMEOUT_MS,
    maxRetries: 0, // handled explicitly by withRetry
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/extropy-assessment/blog-assistant',
      'X-Title': 'Blog Platform Blog Assistant',
    },
  });

type OpenStreamArgs = {
  client: OpenAI;
  model: string;
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionTool[];
  toolChoice: 'auto' | 'none';
  logger: TracedLogger;
};

/**
 * Open a streamed completion with retry + backoff on the initial request.
 * Only the initial HTTP handshake / 5xx-before-first-chunk is retried;
 * mid-stream failures surface to the caller as a stream error frame — there
 * is no safe way to resume a partial LLM response.
 */
const openStream = ({ client, model, messages, tools, toolChoice, logger }: OpenStreamArgs) =>
  withRetry(
    (signal) =>
      client.chat.completions.create(
        {
          model,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: MAX_TOKENS_OUT,
          messages,
          tools,
          tool_choice: toolChoice,
        },
        { signal },
      ),
    {
      op: `openrouter.completions.create[${model}]`,
      attempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 4000,
      timeoutMs: CONNECT_TIMEOUT_MS,
      logger,
    },
  );

export const streamChat = async (
  ctx: StreamContext,
  emit: (frame: ChatStreamFrame) => void,
): Promise<void> => {
  const cfg = env();
  if (!cfg.OPENROUTER_API_KEY) throw serviceUnavailable('AI is not configured');

  const client = buildClient(cfg.OPENROUTER_API_KEY);
  const primary = cfg.OPENROUTER_MODEL;
  const fallback = cfg.OPENROUTER_FALLBACK_MODEL;
  const logger = ctx.logger.child({ primary, fallback });

  // Ground on the user's most recent turn. If they've asked a follow-up we
  // retrieve fresh chunks each turn — cheaper than caching, keeps recall
  // aligned with the current question.
  const lastUserMsg = [...ctx.messages].reverse().find((m) => m.role === 'user');
  const retrievalQuery = lastUserMsg?.content ?? '';
  const retrieved = retrievalQuery
    ? await retrieveChunks(
        retrievalQuery,
        { userId: ctx.userId, role: ctx.role },
        cfg.CHAT_RETRIEVAL_K,
        logger,
      )
    : [];

  // Reserve room for the system prompt + retrieval; trim history to fit.
  const systemPrompt = buildSystemPrompt(ctx.role, ctx.displayName, formatContext(retrieved));
  const systemTokens = estimateTokens(systemPrompt);
  const historyBudget = Math.max(1000, cfg.CHAT_HISTORY_TOKEN_BUDGET - systemTokens);
  const trimmed = applySlidingWindow(ctx.messages, historyBudget);

  logger.info('chat.started', {
    userId: ctx.userId,
    role: ctx.role,
    retrievalHits: retrieved.length,
    historyIn: ctx.messages.length,
    historyKept: trimmed.kept.length,
    historyDropped: trimmed.droppedCount,
    historyTokens: trimmed.usedTokens,
    systemTokens,
  });

  const conversation: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...trimmed.kept.map<ChatCompletionMessageParam>((m) => ({ role: m.role, content: m.content })),
  ];

  // Readers get read-only tools; authors additionally get create/update.
  const tools = buildTools(ctx.role);

  const startedAt = Date.now();
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let usedModel = primary;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const toolChoice = round === MAX_TOOL_ROUNDS - 1 ? 'none' : 'auto';

    let stream;
    try {
      // Once we've fallen back mid-conversation, stick with the fallback for
      // subsequent tool rounds — mixing models across turns would give the
      // second turn a different tokenizer/format contract than the first.
      stream = await openStream({ client, model: usedModel, messages: conversation, tools, toolChoice, logger });
    } catch (primaryErr) {
      // Fall back to the cheaper model exactly once, only on the first round
      // (before any tokens have been streamed to the client).
      if (round !== 0 || usedModel !== primary || primary === fallback) {
        logger.error('chat.primary.failed_terminal', {
          error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
        });
        emit({
          type: 'error',
          message:
            'The assistant is temporarily unavailable. Please try again in a moment.',
        });
        return;
      }
      logger.warn('chat.primary.failed_falling_back', {
        error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
      });
      try {
        stream = await openStream({
          client,
          model: fallback,
          messages: conversation,
          tools,
          toolChoice,
          logger,
        });
        usedModel = fallback;
      } catch (fallbackErr) {
        logger.error('chat.fallback.failed', {
          error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
        emit({
          type: 'error',
          message:
            'The assistant is temporarily unavailable. Please try again in a moment.',
        });
        return;
      }
    }

    let consumed: StreamConsumption;
    try {
      consumed = await consumeStream(stream, emit, logger);
    } catch (streamErr) {
      logger.error('chat.stream.midflight_failed', {
        error: streamErr instanceof Error ? streamErr.message : String(streamErr),
      });
      emit({ type: 'error', message: 'The response was interrupted. Please retry.' });
      return;
    }

    if (consumed.usage) {
      totalPromptTokens += consumed.usage.prompt_tokens ?? 0;
      totalCompletionTokens += consumed.usage.completion_tokens ?? 0;
    } else {
      // Provider withheld usage — fall back to estimator so cost logs still
      // populate. Estimator is intentionally conservative (over-counts).
      totalPromptTokens += conversation.reduce(
        (sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : ''),
        0,
      );
      totalCompletionTokens += estimateTokens(consumed.assistantText);
    }

    if (consumed.finishReason !== 'tool_calls' || consumed.toolCalls.length === 0) {
      const cost = estimateCost(usedModel, totalPromptTokens, totalCompletionTokens);
      logger.info('chat.completed', {
        latencyMs: Date.now() - startedAt,
        rounds: round + 1,
        finishReason: consumed.finishReason,
        ...cost,
      });
      emit({ type: 'done' });
      return;
    }

    conversation.push({
      role: 'assistant',
      content: consumed.assistantText.length > 0 ? consumed.assistantText : null,
      tool_calls: consumed.toolCalls.map<ChatCompletionMessageToolCall>((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.args },
      })),
    });

    for (const call of consumed.toolCalls) {
      emit({ type: 'tool', name: call.name });
      const result = await executeTool(call, ctx.userId, ctx.role, logger);
      conversation.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }

  const cost = estimateCost(usedModel, totalPromptTokens, totalCompletionTokens);
  logger.info('chat.completed', {
    latencyMs: Date.now() - startedAt,
    rounds: MAX_TOOL_ROUNDS,
    finishReason: 'max_rounds',
    ...cost,
  });
  emit({ type: 'done' });
};
