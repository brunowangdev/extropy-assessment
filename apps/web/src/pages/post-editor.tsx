import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createPostSchema, tagSchema, type CreatePostInput } from '@blog/shared';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TagChip } from '@/components/tag-chip';

export const PostEditorPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isEdit = Boolean(id);

  const { data: existing, isPending: loadingExisting } = useQuery({
    queryKey: ['post', id],
    queryFn: () => api.getPost(id!),
    enabled: isEdit,
  });

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<CreatePostInput>({
    resolver: zodResolver(createPostSchema),
    defaultValues: { title: '', content: '', tags: [], published: false },
  });

  const currentTags = watch('tags') ?? [];
  const [tagInput, setTagInput] = useState('');
  const [tagError, setTagError] = useState<string | undefined>();

  useEffect(() => {
    if (existing) {
      reset({
        title: existing.title,
        content: existing.content,
        tags: existing.tags,
        published: existing.published,
      });
    }
  }, [existing, reset]);

  const addTag = () => {
    const raw = tagInput.trim().toLowerCase();
    if (!raw) return;
    const parsed = tagSchema.safeParse(raw);
    if (!parsed.success) {
      setTagError(parsed.error.issues[0]?.message ?? 'Invalid tag');
      return;
    }
    if (currentTags.includes(parsed.data)) {
      setTagError('Tag already added');
      return;
    }
    if (currentTags.length >= 8) {
      setTagError('At most 8 tags per post');
      return;
    }
    setValue('tags', [...currentTags, parsed.data], { shouldDirty: true });
    setTagInput('');
    setTagError(undefined);
  };

  const removeTag = (t: string) => {
    setValue(
      'tags',
      currentTags.filter((x) => x !== t),
      { shouldDirty: true },
    );
  };

  const mutation = useMutation({
    mutationFn: (values: CreatePostInput) =>
      isEdit ? api.updatePost(id!, values) : api.createPost(values),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['posts'] });
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      navigate('/author');
    },
  });

  if (isEdit && loadingExisting) return <p className="text-muted-foreground">Loading post…</p>;

  return (
    <div className="max-w-2xl mx-auto">
      <Card>
        <CardHeader>
          <CardTitle>{isEdit ? 'Edit post' : 'New post'}</CardTitle>
          <CardDescription>
            Write in Markdown. Toggle publish when you're ready to share it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={handleSubmit((values) => mutation.mutate(values))}
            noValidate
          >
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input id="title" {...register('title')} />
              {errors.title && (
                <p className="text-xs text-destructive">{errors.title.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="content">Content</Label>
              <Textarea
                id="content"
                {...register('content')}
                className="min-h-[280px] font-mono"
                placeholder="# Hello&#10;&#10;Markdown works here."
              />
              {errors.content && (
                <p className="text-xs text-destructive">{errors.content.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="tag-input">Tags</Label>
              <div className="flex gap-2">
                <Input
                  id="tag-input"
                  value={tagInput}
                  onChange={(e) => {
                    setTagInput(e.target.value);
                    setTagError(undefined);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault();
                      addTag();
                    }
                  }}
                  placeholder="e.g. react, serverless"
                />
                <Button type="button" variant="outline" onClick={addTag}>
                  Add
                </Button>
              </div>
              {tagError && <p className="text-xs text-destructive">{tagError}</p>}
              {currentTags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {currentTags.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => removeTag(t)}
                      className="group"
                      title="Click to remove"
                    >
                      <TagChip
                        tag={t}
                        asLink={false}
                        className="group-hover:bg-destructive group-hover:text-destructive-foreground group-hover:border-destructive"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" {...register('published')} />
              Published
            </label>

            {mutation.isError && (
              <p className="text-sm text-destructive">{mutation.error.message}</p>
            )}

            <div className="flex gap-2 justify-end pt-2">
              <Button type="button" variant="outline" onClick={() => navigate('/author')}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting || mutation.isPending}>
                {mutation.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};
