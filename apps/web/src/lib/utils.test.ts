import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('merges truthy class names', () => {
    expect(cn('a', 'b', false, 'c')).toBe('a b c');
  });

  it('resolves tailwind conflicts, last wins', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4');
  });
});
