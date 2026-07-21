import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TagChip } from '@/components/tag-chip';

export const AuthorDashboardPage = () => {
  const queryClient = useQueryClient();
  const { data: posts, isPending, isError, error } = useQuery({
    queryKey: ['posts', 'mine'],
    queryFn: api.listMine,
  });

  const deleteMutation = useMutation({
    mutationFn: api.deletePost,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['posts'] }),
  });

  const handleDelete = (id: string) => {
    if (confirm('Delete this post? This cannot be undone.')) {
      deleteMutation.mutate(id);
    }
  };

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Your posts</h1>
          <p className="text-muted-foreground mt-1">Drafts and published pieces.</p>
        </div>
        <Button asChild>
          <Link to="/author/posts/new">New post</Link>
        </Button>
      </header>

      {isPending && <p className="text-muted-foreground">Loading…</p>}
      {isError && <p className="text-destructive">Error: {error.message}</p>}

      {posts && posts.length === 0 && (
        <div className="rounded-md border border-dashed border-border p-8 text-center text-muted-foreground">
          No posts yet. Create your first one to get started.
        </div>
      )}

      {posts && posts.length > 0 && (
        <ul className="space-y-3">
          {posts.map((post) => (
            <li key={post.id}>
              <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                  <div className="min-w-0">
                    <CardTitle className="truncate">{post.title}</CardTitle>
                    <CardDescription>
                      {post.published ? (
                        <>
                          Published ·{' '}
                          {new Date(post.publishedAt ?? post.createdAt).toLocaleDateString()}
                        </>
                      ) : (
                        <span className="text-amber-600 font-medium">Draft</span>
                      )}{' '}
                      · Updated {new Date(post.updatedAt).toLocaleDateString()}
                    </CardDescription>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button asChild size="sm" variant="outline">
                      <Link to={`/author/posts/${post.id}/edit`}>Edit</Link>
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => handleDelete(post.id)}
                      disabled={deleteMutation.isPending}
                    >
                      Delete
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {post.content.slice(0, 200)}
                    {post.content.length > 200 ? '…' : ''}
                  </p>
                  {post.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {post.tags.map((t) => (
                        <TagChip key={t} tag={t} asLink={false} />
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
