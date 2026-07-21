import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { api } from '@/lib/api';
import { TagChip } from '@/components/tag-chip';

export const PostDetailPage = () => {
  const { id } = useParams<{ id: string }>();

  const { data: post, isPending, isError, error } = useQuery({
    queryKey: ['post', id],
    queryFn: () => api.getPost(id!),
    enabled: Boolean(id),
  });

  if (isPending) return <p className="text-muted-foreground">Loading post…</p>;
  if (isError) return <p className="text-destructive">Couldn't load post: {error.message}</p>;

  return (
    <article className="space-y-6">
      <header className="border-b border-border pb-4 space-y-3">
        <h1 className="text-3xl font-bold tracking-tight">{post.title}</h1>
        <p className="text-sm text-muted-foreground">
          by{' '}
          <Link
            to={`/authors/${post.authorId}`}
            className="hover:underline underline-offset-4 text-foreground"
          >
            {post.authorName}
          </Link>{' '}
          · {new Date(post.publishedAt ?? post.createdAt).toLocaleDateString()}
          {!post.published && (
            <span className="ml-2 text-amber-600 font-medium">· Draft</span>
          )}
        </p>
        {post.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {post.tags.map((t) => (
              <TagChip key={t} tag={t} />
            ))}
          </div>
        )}
      </header>
      <div className="prose-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
          {post.content}
        </ReactMarkdown>
      </div>
    </article>
  );
};
