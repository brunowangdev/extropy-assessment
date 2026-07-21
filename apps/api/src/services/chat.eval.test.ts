import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatStreamFrame } from '@blog/shared';
import { withTrace } from '../lib/logger.js';

/**
 * Prompt-evaluation harness. This isn't a "call the real LLM and grade the
 * answer" workflow — that class of eval needs a scored corpus and rate-limit
 * budget beyond the assessment. Instead it's the deterministic layer that
 * every LLM eval builds on: given known inputs (corpus + query + role), we
 * assert on the exact prompt shape the model will see, and on how tool
 * responses are marshalled back.
 *
 * When you graduate to full evals (Braintrust, LangSmith, promptfoo), the
 * per-scenario setup here becomes the fixture generator.
 */

const RAG_MOCK = vi.hoisted(() => ({ retrieveChunks: vi.fn() }));
const OPENAI_MOCK = vi.hoisted(() => ({
  create: vi.fn(),
}));
// Mock the posts service so the authoring tools' wiring can be tested without
// a real Mongo. The posts service enforces ownership/validation itself; here we
// only assert how chat.ts marshals inputs into it and results back to the model.
const POSTS_MOCK = vi.hoisted(() => ({
  createPost: vi.fn(),
  updatePost: vi.fn(),
  deletePost: vi.fn(),
}));

vi.mock('./rag.js', () => ({
  retrieveChunks: RAG_MOCK.retrieveChunks,
  indexPost: vi.fn(),
  removePostFromIndex: vi.fn(),
  chunks: vi.fn(),
  chunkPost: vi.fn(),
}));

vi.mock('./posts.js', () => ({
  createPost: POSTS_MOCK.createPost,
  updatePost: POSTS_MOCK.updatePost,
  deletePost: POSTS_MOCK.deletePost,
}));

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: OPENAI_MOCK.create } };
    },
  };
});

vi.mock('../lib/db.js', () => ({
  db: vi.fn(),
  posts: vi.fn(async () => ({
    findOne: vi.fn(async () => ({ content: 'full body', published: true, authorId: 'a' })),
  })),
  users: vi.fn(),
}));

// Yield a scripted sequence of streaming chunks as an async iterable.
const asStream = (chunks: unknown[]) => ({
  async *[Symbol.asyncIterator]() {
    for (const c of chunks) yield c;
  },
});

const textChunk = (value: string) => ({
  choices: [{ delta: { content: value }, finish_reason: null }],
});
const doneChunk = () => ({
  choices: [{ delta: {}, finish_reason: 'stop' }],
  usage: { prompt_tokens: 120, completion_tokens: 40 },
});
const toolCallChunk = (id: string, name: string, args: string) => ({
  choices: [
    {
      delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] },
      finish_reason: null,
    },
  ],
});
const toolFinishChunk = () => ({
  choices: [{ delta: {}, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 100, completion_tokens: 5 },
});
const toolNames = (callIndex: number): string[] =>
  ((OPENAI_MOCK.create.mock.calls[callIndex]![0] as { tools?: Array<{ function: { name: string } }> })
    .tools ?? []).map((t) => t.function.name);
const toolReplyContent = (callIndex: number): string | undefined => {
  const req = OPENAI_MOCK.create.mock.calls[callIndex]![0] as {
    messages: Array<{ role: string; content?: string | null }>;
  };
  return req.messages.find((m) => m.role === 'tool')?.content ?? undefined;
};

const runChat = async (messages: ChatMessage[], role: 'author' | 'reader' = 'reader') => {
  process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
  process.env.OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.5';
  process.env.JWT_SECRET = 'a'.repeat(64);
  process.env.MONGODB_URI = 'mongodb://localhost:27017';
  process.env.LOG_LEVEL = 'error'; // silence during tests

  const { streamChat } = await import('./chat.js');
  const frames: ChatStreamFrame[] = [];
  await streamChat(
    {
      userId: '11111111-1111-1111-1111-111111111111',
      role,
      displayName: 'Alex',
      messages,
      logger: withTrace('t-test'),
    },
    (f) => frames.push(f),
  );
  return frames;
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  RAG_MOCK.retrieveChunks.mockReset();
  OPENAI_MOCK.create.mockReset();
  POSTS_MOCK.createPost.mockReset();
  POSTS_MOCK.updatePost.mockReset();
  POSTS_MOCK.deletePost.mockReset();
});

describe('chat eval — grounding', () => {
  it('passes retrieved chunks into the system prompt', async () => {
    RAG_MOCK.retrieveChunks.mockResolvedValue([
      {
        postId: '22222222-2222-2222-2222-222222222222',
        title: 'Adopting Rust in prod',
        text: 'Rust in production requires careful team onboarding.',
        score: 0.9,
        published: true,
        publishedAt: new Date('2026-05-01'),
        chunkIndex: 0,
      },
    ]);
    OPENAI_MOCK.create.mockResolvedValue(asStream([textChunk('Sure. '), textChunk('Here.'), doneChunk()]));

    await runChat([{ role: 'user', content: 'Tell me about Rust posts' }]);

    expect(OPENAI_MOCK.create).toHaveBeenCalled();
    const req = OPENAI_MOCK.create.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string | null }>;
    };
    const system = req.messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('post_id=22222222-2222-2222-2222-222222222222');
    expect(system?.content).toContain('Adopting Rust in prod');
    expect(system?.content).toContain('Grounding rules');
  });

  it('tells the model there is no context when retrieval returns nothing', async () => {
    RAG_MOCK.retrieveChunks.mockResolvedValue([]);
    OPENAI_MOCK.create.mockResolvedValue(asStream([textChunk('Nothing yet.'), doneChunk()]));

    await runChat([{ role: 'user', content: 'What is here?' }]);

    const req = OPENAI_MOCK.create.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string | null }>;
    };
    const system = req.messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('(no relevant posts found)');
  });

  it('uses only the latest user turn to drive retrieval', async () => {
    RAG_MOCK.retrieveChunks.mockResolvedValue([]);
    OPENAI_MOCK.create.mockResolvedValue(asStream([textChunk('.'), doneChunk()]));

    await runChat([
      { role: 'user', content: 'irrelevant first question' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'THE ACTUAL QUERY' },
    ]);

    expect(RAG_MOCK.retrieveChunks).toHaveBeenCalledOnce();
    const query = RAG_MOCK.retrieveChunks.mock.calls[0]![0];
    expect(query).toBe('THE ACTUAL QUERY');
  });
});

describe('chat eval — tool call safety', () => {
  it('returns a schema error string when the model calls get_post with a non-uuid id', async () => {
    RAG_MOCK.retrieveChunks.mockResolvedValue([]);
    // Round 1: model calls tool with bad args. Round 2: model returns text.
    OPENAI_MOCK.create
      .mockResolvedValueOnce(
        asStream([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      function: { name: 'get_post', arguments: '{"id":"not-a-uuid"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 100, completion_tokens: 5 },
          },
        ]),
      )
      .mockResolvedValueOnce(asStream([textChunk('Apologies, retrying.'), doneChunk()]));

    const frames = await runChat([{ role: 'user', content: 'Fetch that post' }]);

    expect(frames.some((f) => f.type === 'tool')).toBe(true);
    // Second-round call was made with a tool-result message carrying the error.
    const round2 = OPENAI_MOCK.create.mock.calls[1]![0] as {
      messages: Array<{ role: string; content?: string | null }>;
    };
    const toolReply = round2.messages.find((m) => m.role === 'tool');
    expect(toolReply?.content).toMatch(/Error: invalid arguments/);
  });

  it('rejects unparseable tool arguments cleanly', async () => {
    RAG_MOCK.retrieveChunks.mockResolvedValue([]);
    OPENAI_MOCK.create
      .mockResolvedValueOnce(
        asStream([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'c', function: { name: 'get_post', arguments: '{not json' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      )
      .mockResolvedValueOnce(asStream([textChunk('ok'), doneChunk()]));

    await runChat([{ role: 'user', content: 'Fetch that post' }]);
    const round2 = OPENAI_MOCK.create.mock.calls[1]![0] as {
      messages: Array<{ role: string; content?: string | null }>;
    };
    const toolReply = round2.messages.find((m) => m.role === 'tool');
    expect(toolReply?.content).toMatch(/not valid JSON/);
  });
});

describe('chat eval — authoring tools', () => {
  const AUTHOR_ID = '11111111-1111-1111-1111-111111111111';

  it('offers create/update tools to authors but only read tools to readers', async () => {
    RAG_MOCK.retrieveChunks.mockResolvedValue([]);
    OPENAI_MOCK.create.mockResolvedValue(asStream([textChunk('.'), doneChunk()]));

    await runChat([{ role: 'user', content: 'hi' }], 'author');
    expect(toolNames(0)).toEqual(
      expect.arrayContaining(['get_post', 'create_post', 'update_post', 'delete_post']),
    );

    OPENAI_MOCK.create.mockClear();
    OPENAI_MOCK.create.mockResolvedValue(asStream([textChunk('.'), doneChunk()]));
    await runChat([{ role: 'user', content: 'hi' }], 'reader');
    expect(toolNames(0)).toEqual(['get_post']);
  });

  it('marshals a create_post call into the service and its result back to the model', async () => {
    RAG_MOCK.retrieveChunks.mockResolvedValue([]);
    POSTS_MOCK.createPost.mockResolvedValue({
      id: '33333333-3333-3333-3333-333333333333',
      title: 'My Post',
      published: false,
    });
    OPENAI_MOCK.create
      .mockResolvedValueOnce(
        asStream([
          toolCallChunk('call_c', 'create_post', '{"title":"My Post","content":"Hello world"}'),
          toolFinishChunk(),
        ]),
      )
      .mockResolvedValueOnce(asStream([textChunk('Done.'), doneChunk()]));

    const frames = await runChat([{ role: 'user', content: 'write a post' }], 'author');

    // Defaults from createPostSchema are applied (tags:[], published:false).
    expect(POSTS_MOCK.createPost).toHaveBeenCalledWith(
      AUTHOR_ID,
      expect.objectContaining({ title: 'My Post', content: 'Hello world', published: false, tags: [] }),
      expect.anything(),
    );
    expect(frames.some((f) => f.type === 'tool')).toBe(true);
    const reply = toolReplyContent(1);
    expect(reply).toContain('33333333-3333-3333-3333-333333333333');
    expect(reply).toMatch(/draft/);
  });

  it('refuses create_post for readers even if the model emits the call', async () => {
    RAG_MOCK.retrieveChunks.mockResolvedValue([]);
    OPENAI_MOCK.create
      .mockResolvedValueOnce(
        asStream([toolCallChunk('c', 'create_post', '{"title":"x","content":"y"}'), toolFinishChunk()]),
      )
      .mockResolvedValueOnce(asStream([textChunk('ok'), doneChunk()]));

    await runChat([{ role: 'user', content: 'make a post' }], 'reader');

    expect(POSTS_MOCK.createPost).not.toHaveBeenCalled();
    expect(toolReplyContent(1)).toMatch(/only authors/i);
  });

  it('returns a schema error when create_post is missing a required field', async () => {
    RAG_MOCK.retrieveChunks.mockResolvedValue([]);
    OPENAI_MOCK.create
      .mockResolvedValueOnce(
        asStream([toolCallChunk('c', 'create_post', '{"title":"only a title"}'), toolFinishChunk()]),
      )
      .mockResolvedValueOnce(asStream([textChunk('ok'), doneChunk()]));

    await runChat([{ role: 'user', content: 'post it' }], 'author');

    expect(POSTS_MOCK.createPost).not.toHaveBeenCalled();
    expect(toolReplyContent(1)).toMatch(/invalid arguments/);
  });

  it('surfaces an ownership error from update_post back to the model', async () => {
    RAG_MOCK.retrieveChunks.mockResolvedValue([]);
    const { AppError } = await import('../lib/errors.js');
    POSTS_MOCK.updatePost.mockRejectedValue(new AppError(403, 'Not your post'));
    OPENAI_MOCK.create
      .mockResolvedValueOnce(
        asStream([
          toolCallChunk(
            'u',
            'update_post',
            '{"id":"44444444-4444-4444-4444-444444444444","title":"New title"}',
          ),
          toolFinishChunk(),
        ]),
      )
      .mockResolvedValueOnce(asStream([textChunk('Sorry.'), doneChunk()]));

    await runChat([{ role: 'user', content: 'rename that post' }], 'author');

    expect(POSTS_MOCK.updatePost).toHaveBeenCalledWith(
      '44444444-4444-4444-4444-444444444444',
      AUTHOR_ID,
      expect.objectContaining({ title: 'New title' }),
      expect.anything(),
    );
    expect(toolReplyContent(1)).toMatch(/Not your post/);
  });

  it('marshals a delete_post call into the service and confirms back to the model', async () => {
    RAG_MOCK.retrieveChunks.mockResolvedValue([]);
    POSTS_MOCK.deletePost.mockResolvedValue(undefined);
    OPENAI_MOCK.create
      .mockResolvedValueOnce(
        asStream([
          toolCallChunk('d', 'delete_post', '{"id":"55555555-5555-5555-5555-555555555555"}'),
          toolFinishChunk(),
        ]),
      )
      .mockResolvedValueOnce(asStream([textChunk('Deleted.'), doneChunk()]));

    await runChat([{ role: 'user', content: 'yes, delete it' }], 'author');

    expect(POSTS_MOCK.deletePost).toHaveBeenCalledWith(
      '55555555-5555-5555-5555-555555555555',
      AUTHOR_ID,
      expect.anything(),
    );
    expect(toolReplyContent(1)).toMatch(/Deleted post 55555555-5555-5555-5555-555555555555/);
  });

  it('refuses delete_post for readers even if the model emits the call', async () => {
    RAG_MOCK.retrieveChunks.mockResolvedValue([]);
    OPENAI_MOCK.create
      .mockResolvedValueOnce(
        asStream([
          toolCallChunk('d', 'delete_post', '{"id":"55555555-5555-5555-5555-555555555555"}'),
          toolFinishChunk(),
        ]),
      )
      .mockResolvedValueOnce(asStream([textChunk('ok'), doneChunk()]));

    await runChat([{ role: 'user', content: 'delete that post' }], 'reader');

    expect(POSTS_MOCK.deletePost).not.toHaveBeenCalled();
    expect(toolReplyContent(1)).toMatch(/only authors/i);
  });
});

describe('chat eval — resilience', () => {
  it('emits an error frame + returns without crashing when the provider fails', async () => {
    RAG_MOCK.retrieveChunks.mockResolvedValue([]);
    const err = Object.assign(new Error('nope'), { status: 500 });
    OPENAI_MOCK.create.mockRejectedValue(err);

    const frames = await runChat([{ role: 'user', content: 'Hi' }]);
    expect(frames.some((f) => f.type === 'error')).toBe(true);
    expect(frames.at(-1)?.type).not.toBe('text');
  });
});
