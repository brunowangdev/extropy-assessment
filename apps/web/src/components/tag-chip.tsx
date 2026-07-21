import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

type Props = {
  tag: string;
  count?: number;
  active?: boolean;
  asLink?: boolean;
  className?: string;
};

export const TagChip = ({ tag, count, active = false, asLink = true, className }: Props) => {
  const classes = cn(
    'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
    active
      ? 'border-primary bg-primary text-primary-foreground'
      : 'border-border bg-muted text-muted-foreground hover:bg-border/60',
    className,
  );

  const body = (
    <>
      <span>#{tag}</span>
      {count !== undefined && <span className="opacity-70">·{count}</span>}
    </>
  );

  if (!asLink) return <span className={classes}>{body}</span>;

  return (
    <Link to={active ? '/' : `/?tag=${encodeURIComponent(tag)}`} className={classes}>
      {body}
    </Link>
  );
};
