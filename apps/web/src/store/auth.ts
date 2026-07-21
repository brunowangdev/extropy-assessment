import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '@blog/shared';

type AuthState = {
  token: string | null;
  user: User | null;
  setSession: (token: string, user: User) => void;
  clear: () => void;
};

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setSession: (token, user) => set({ token, user }),
      clear: () => set({ token: null, user: null }),
    }),
    { name: 'ink-auth' },
  ),
);

/** Non-hook accessor for API layer where hooks can't be used. */
export const getToken = (): string | null => useAuth.getState().token;
