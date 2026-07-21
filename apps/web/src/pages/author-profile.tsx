import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TagChip } from '@/components/tag-chip';

export const AuthorProfilePage = () => {
  const { id } = useParams<{ id: string }>();
  const { data, isPending, isError, error } = useQuery({
    queryKey: ['author', id],
    queryFn: () => api.getAuthor(id!),
    enabled: Boolean(id),
  });

  if (isPending) return <p className="text-muted-foreground">Loading author…</p>;
  if (isError) return <p className="text-destructive">Couldn't load author: {error.message}</p>;

  return (
    <section className="space-y-6">
      <header className="border-b border-border pb-6">
        <h1 className="text-3xl font-bold tracking-tight">{data.displayName}</h1>
        <p className="text-sm text-muted-foreground mt-2">
          Joined {new Date(data.joinedAt).toLocaleDateString()} ·{' '}
          {data.publishedPostCount} published{' '}
          {data.publishedPostCount === 1 ? 'post' : 'posts'}
        </p>
      </header>

      <div>
        <h2 className="text-lg font-semibold mb-3">Recent posts</h2>
        {data.recentPosts.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-8 text-center text-muted-foreground">
            {data.displayName} hasn't published anything yet.
          </div>
        ) : (
          <ul className="space-y-3">
            {data.recentPosts.map((post) => (
              <li key={post.id}>
                <Card>
                  <CardHeader>
                    <CardTitle>
                      <Link
                        to={`/posts/${post.id}`}
                        className="hover:underline underline-offset-4"
                      >
                        {post.title}
                      </Link>
                    </CardTitle>
                    <CardDescription>
                      {new Date(post.publishedAt ?? post.createdAt).toLocaleDateString()}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {post.content.slice(0, 200)}
                      {post.content.length > 200 ? '…' : ''}
                    </p>
                    {post.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {post.tags.map((t) => (
                          <TagChip key={t} tag={t} />
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
};
