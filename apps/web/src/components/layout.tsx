import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '@/store/auth';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

export const Layout = () => {
  const { user, clear } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    clear();
    navigate('/');
  };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-xl font-semibold tracking-tight">
            Blog Platform
          </Link>
          <nav className="flex items-center gap-1 sm:gap-2 text-sm">
            <NavLinkStyled to="/">Read</NavLinkStyled>
            {user?.role === 'author' && <NavLinkStyled to="/author">Write</NavLinkStyled>}
            {user && <NavLinkStyled to="/chat">Chat</NavLinkStyled>}
            {user ? (
              <>
                <span className="hidden sm:inline text-muted-foreground px-2">
                  {user.displayName}
                </span>
                <Button variant="ghost" size="sm" onClick={handleLogout}>
                  Log out
                </Button>
              </>
            ) : (
              <>
                <Button asChild variant="ghost" size="sm">
                  <Link to="/login">Log in</Link>
                </Button>
                <Button asChild size="sm">
                  <Link to="/signup">Sign up</Link>
                </Button>
              </>
            )}
          </nav>
        </div>
      </header>
      <main className="flex-1 mx-auto w-full max-w-4xl px-4 py-6 sm:py-10">
        <Outlet />
      </main>
      <footer className="border-t border-border text-xs text-muted-foreground">
        <div className="mx-auto max-w-4xl px-4 py-4">
          Built for the Extropy home assessment.
        </div>
      </footer>
    </div>
  );
};

const NavLinkStyled = ({
  to,
  children,
}: {
  to: string;
  children: React.ReactNode;
}) => (
  <NavLink
    to={to}
    end={to === '/'}
    className={({ isActive }) =>
      cn(
        'px-2 py-1 rounded-md hover:bg-muted transition-colors',
        isActive && 'bg-muted font-medium',
      )
    }
  >
    {children}
  </NavLink>
);
