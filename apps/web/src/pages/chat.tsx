import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import type { ChatMessage } from '@blog/shared';
import { streamChatMessages } from '@/lib/api';
import { useAuth } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

type UiMessage = ChatMessage & { streaming?: boolean; error?: string; tool?: string };

const initialGreeting = (role: 'author' | 'reader', name: string): UiMessage => ({
  role: 'assistant',
  content:
    role === 'author'
      ? `Hi ${name}! I can see your posts — drafts and published. Ask me about themes or specific pieces, or ask me to draft a new post or edit an existing one for you.`
      : `Hi ${name}! I can see the site's published posts. Ask me for recommendations, summaries, or what's covered here.`,
});

// Friendly labels for the tool-call activity indicator.
const TOOL_LABELS: Record<string, string> = {
  get_post: 'reading a post',
  create_post: 'creating a post',
  update_post: 'editing a post',
  delete_post: 'deleting a post',
};

export const ChatPage = () => {
  const { user } = useAuth();
  const [messages, setMessages] = useState<UiMessage[]>(() =>
    user ? [initialGreeting(user.role, user.displayName)] : [],
  );
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const send = async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    setInput('');

    const nextHistory: UiMessage[] = [
      ...messages,
      { role: 'user', content: trimmed },
      { role: 'assistant', content: '', streaming: true },
    ];
    setMessages(nextHistory);
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // Send only real chat messages (strip greeting + streaming placeholder + errors).
    const wirePayload: ChatMessage[] = nextHistory
      .slice(0, -1)
      .filter((m, idx) => !(idx === 0 && m.role === 'assistant'))
      .filter((m) => !m.error)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      for await (const frame of streamChatMessages(wirePayload, controller.signal)) {
        if (frame.type === 'text') {
          setMessages((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.streaming) {
              copy[copy.length - 1] = { ...last, content: last.content + frame.value };
            }
            return copy;
          });
        } else if (frame.type === 'tool') {
          setMessages((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.streaming) copy[copy.length - 1] = { ...last, tool: frame.name };
            return copy;
          });
        } else if (frame.type === 'error') {
          setMessages((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.streaming) {
              copy[copy.length - 1] = { ...last, error: frame.message, streaming: false };
            }
            return copy;
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong.';
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last && last.streaming) copy[copy.length - 1] = { ...last, error: msg, streaming: false };
        return copy;
      });
    } finally {
      setMessages((prev) =>
        prev.map((m, i) =>
          i === prev.length - 1 && m.streaming ? { ...m, streaming: false } : m,
        ),
      );
      setIsStreaming(false);
      abortRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setIsStreaming(false);
  };

  return (
    <section className="flex flex-col h-[calc(100vh-11rem)] max-h-[720px]">
      <header className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight">Assistant</h1>
        <p className="text-sm text-muted-foreground">
          Ask about {user?.role === 'author' ? 'your posts' : "the blog's posts"}.
        </p>
      </header>

      <div className="flex-1 overflow-y-auto space-y-4 pr-1">
        {messages.map((m, i) => (
          <MessageBubble key={i} message={m} />
        ))}
      </div>

      <form
        className="mt-4 border-t border-border pt-4 flex gap-2 items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Ask a question…"
          className="min-h-[52px] max-h-40 resize-none"
          disabled={isStreaming}
        />
        {isStreaming ? (
          <Button type="button" variant="outline" onClick={stop}>
            Stop
          </Button>
        ) : (
          <Button type="submit" disabled={!input.trim()}>
            Send
          </Button>
        )}
      </form>
    </section>
  );
};

const MessageBubble = ({ message }: { message: UiMessage }) => {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-4 py-3 text-sm',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
        )}
      >
        {message.tool && (
          <p className="text-xs opacity-70 mb-1 italic">
            ({TOOL_LABELS[message.tool] ?? `calling ${message.tool}`}…)
          </p>
        )}
        {message.content ? (
          <div className="prose-content text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
              {message.content}
            </ReactMarkdown>
          </div>
        ) : message.streaming ? (
          <span className="inline-flex gap-1 items-center opacity-70">
            <span className="animate-pulse">·</span>
            <span className="animate-pulse delay-75">·</span>
            <span className="animate-pulse delay-150">·</span>
          </span>
        ) : null}
        {message.error && (
          <p className="mt-2 text-xs text-destructive">Error: {message.error}</p>
        )}
      </div>
    </div>
  );
};
