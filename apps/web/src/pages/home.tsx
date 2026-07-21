import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { TagChip } from '@/components/tag-chip';

const PAGE_SIZE = 10;

export const HomePage = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const tag = searchParams.get('tag') ?? undefined;
  const q = searchParams.get('q') ?? undefined;
  const page = Number(searchParams.get('page') ?? '1');

  // Local search input, debounced into the URL.
  const [searchInput, setSearchInput] = useState(q ?? '');
  useEffect(() => setSearchInput(q ?? ''), [q]);
  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === (q ?? '')) return;
    const t = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (trimmed) next.set('q', trimmed);
      else next.delete('q');
      next.delete('page');
      setSearchParams(next, { replace: true });
    }, 300);
    return () => window.clearTimeout(t);
  }, [searchInput, q, searchParams, setSearchParams]);

  const updateParam = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setSearchParams(next);
  };

  const posts = useQuery({
    queryKey: ['posts', 'public', page, q, tag],
    queryFn: () => api.listPublic({ page, pageSize: PAGE_SIZE, q, tag }),
  });

  const allTags = useQuery({ queryKey: ['tags'], queryFn: api.listTags });

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil((posts.data?.total ?? 0) / PAGE_SIZE)),
    [posts.data?.total],
  );

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Recent posts</h1>
        <p className="text-muted-foreground mt-1">
          Published writing from authors on Blog Platform.
        </p>
      </header>

      {/* Search + filter row */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          type="search"
          placeholder="Search posts…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="sm:max-w-xs"
        />
        {tag && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>Filtered by</span>
            <TagChip tag={tag} active asLink={false} />
            <button
              type="button"
              className="underline underline-offset-4 hover:text-foreground"
              onClick={() => updateParam('tag', undefined)}
            >
              clear
            </button>
          </div>
        )}
      </div>

      {allTags.data && allTags.data.tags.length > 0 && !tag && (
        <div className="flex flex-wrap gap-2">
          {allTags.data.tags.slice(0, 20).map((t) => (
            <TagChip key={t.tag} tag={t.tag} count={t.count} />
          ))}
        </div>
      )}

      {posts.isPending && <p className="text-muted-foreground">Loading posts…</p>}
      {posts.isError && (
        <p className="text-destructive">Couldn't load posts: {posts.error.message}</p>
      )}

      {posts.data && posts.data.items.length === 0 && (
        <div className="rounded-md border border-dashed border-border p-8 text-center text-muted-foreground">
          {q || tag
            ? 'No posts match those filters.'
            : 'No posts yet. Be the first — sign up as an author.'}
        </div>
      )}

      {posts.data && posts.data.items.length > 0 && (
        <ul className="space-y-4">
          {posts.data.items.map((post) => (
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
                    by{' '}
                    <Link
                      to={`/authors/${post.authorId}`}
                      className="hover:underline underline-offset-4"
                    >
                      {post.authorName}
                    </Link>{' '}
                    · {new Date(post.publishedAt ?? post.createdAt).toLocaleDateString()}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground line-clamp-3">
                    {post.content.slice(0, 240)}
                    {post.content.length > 240 ? '…' : ''}
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

      {posts.data && totalPages > 1 && (
        <div className="flex items-center justify-between pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => updateParam('page', String(Math.max(1, page - 1)))}
            disabled={page === 1}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => updateParam('page', String(Math.min(totalPages, page + 1)))}
            disabled={page >= totalPages}
          >
            Next
          </Button>
        </div>
      )}
    </section>
  );
};
