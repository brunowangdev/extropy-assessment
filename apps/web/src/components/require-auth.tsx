import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { Role } from '@blog/shared';
import { useAuth } from '@/store/auth';

export const RequireAuth = ({ role }: { role?: Role }) => {
  const { user } = useAuth();
  const location = useLocation();

  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (role && user.role !== role) {
    return (
      <div className="text-center py-16">
        <h2 className="text-lg font-medium">Access restricted</h2>
        <p className="text-sm text-muted-foreground mt-2">
          This area is for {role}s. You're signed in as a {user.role}.
        </p>
      </div>
    );
  }
  return <Outlet />;
};
