import type {
  AuthResponse,
  AuthorProfile,
  ChatMessage,
  ChatStreamFrame,
  LoginInput,
  PaginatedPosts,
  Post,
  SignupInput,
  User,
} from '@blog/shared';
import { config } from './config.js';
import { getToken } from '../store/auth.js';

const authHeaders = (): Record<string, string> => {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const res = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let body: { error?: string } = {};
    try { body = await res.json(); } catch { /* ignore */ }
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
};

export type ListPublicOptions = {
  page?: number | undefined;
  pageSize?: number | undefined;
  q?: string | undefined;
  tag?: string | undefined;
};

const buildQuery = (params: Record<string, string | number | undefined>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return '';
  const usp = new URLSearchParams();
  for (const [k, v] of entries) usp.set(k, String(v));
  return `?${usp.toString()}`;
};

export const api = {
  signup: (input: SignupInput) =>
    request<AuthResponse>('/auth/signup', { method: 'POST', body: JSON.stringify(input) }),
  login: (input: LoginInput) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify(input) }),
  me: () => request<User>('/me'),
  listPublic: (opts: ListPublicOptions = {}) =>
    request<PaginatedPosts>(
      `/posts${buildQuery({
        page: opts.page ?? 1,
        pageSize: opts.pageSize ?? 10,
        q: opts.q,
        tag: opts.tag,
      })}`,
    ),
  listMine: () => request<Post[]>('/me/posts'),
  getPost: (id: string) => request<Post>(`/posts/${id}`),
  createPost: (input: { title: string; content: string; tags: string[]; published: boolean }) =>
    request<Post>('/posts', { method: 'POST', body: JSON.stringify(input) }),
  updatePost: (
    id: string,
    input: Partial<{ title: string; content: string; tags: string[]; published: boolean }>,
  ) => request<Post>(`/posts/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deletePost: (id: string) => request<void>(`/posts/${id}`, { method: 'DELETE' }),
  listTags: () => request<{ tags: Array<{ tag: string; count: number }> }>('/tags'),
  getAuthor: (id: string) => request<AuthorProfile>(`/authors/${id}`),
};

/**
 * Streams chat responses over Server-Sent Events. Yields each parsed frame.
 * Uses fetch()+ReadableStream because EventSource can't POST a body.
 */
export async function* streamChatMessages(
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamFrame, void, void> {
  const res = await fetch(config.chatUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ messages }),
    signal: signal ?? null,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Chat request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        yield JSON.parse(payload) as ChatStreamFrame;
      } catch {
        // Malformed frame — skip rather than abort the stream.
      }
    }
  }
}
