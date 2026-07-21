import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { signupSchema, type SignupInput } from '@blog/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const SignupPage = () => {
  const navigate = useNavigate();
  const { setSession } = useAuth();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupInput>({
    resolver: zodResolver(signupSchema),
    defaultValues: { role: 'reader' },
  });

  const mutation = useMutation({
    mutationFn: api.signup,
    onSuccess: (data) => {
      setSession(data.token, data.user);
      navigate(data.user.role === 'author' ? '/author' : '/', { replace: true });
    },
  });

  return (
    <div className="mx-auto max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>Create your account</CardTitle>
          <CardDescription>Choose whether you'll be reading or writing.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={handleSubmit((values) => mutation.mutate(values))}
            noValidate
          >
            <div className="space-y-2">
              <Label htmlFor="displayName">Display name</Label>
              <Input id="displayName" autoComplete="name" {...register('displayName')} />
              {errors.displayName && (
                <p className="text-xs text-destructive">{errors.displayName.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="email" {...register('email')} />
              {errors.email && (
                <p className="text-xs text-destructive">{errors.email.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                {...register('password')}
              />
              <p className="text-xs text-muted-foreground">At least 8 characters.</p>
              {errors.password && (
                <p className="text-xs text-destructive">{errors.password.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <div className="flex gap-2">
                <label className="flex-1 flex items-center gap-2 border border-border rounded-md px-3 py-2 cursor-pointer has-[:checked]:border-primary has-[:checked]:bg-muted">
                  <input type="radio" value="reader" {...register('role')} />
                  <span className="text-sm">Reader</span>
                </label>
                <label className="flex-1 flex items-center gap-2 border border-border rounded-md px-3 py-2 cursor-pointer has-[:checked]:border-primary has-[:checked]:bg-muted">
                  <input type="radio" value="author" {...register('role')} />
                  <span className="text-sm">Author</span>
                </label>
              </div>
              {errors.role && (
                <p className="text-xs text-destructive">{errors.role.message}</p>
              )}
            </div>
            {mutation.isError && (
              <p className="text-sm text-destructive">{mutation.error.message}</p>
            )}
            <Button type="submit" disabled={isSubmitting || mutation.isPending} className="w-full">
              {mutation.isPending ? 'Creating account…' : 'Sign up'}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              Already have an account?{' '}
              <Link to="/login" className="text-primary underline-offset-4 hover:underline">
                Log in
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};
