import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth.js';
import FullPageSpinner from './FullPageSpinner.jsx';

function resolveRedirect(location) {
  const from = location.state?.from?.pathname;
  if (from && from !== '/login' && from !== '/register') return from;
  return '/';
}

/**
 * Route wrapper for pages that only make sense signed out (login/register).
 * Signed-in users are sent back to the chat (or to the page they originally
 * wanted, for example after a session expired).
 */
export default function PublicRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <FullPageSpinner label="Loading RedChat…" />;
  }

  if (user) {
    return <Navigate to={resolveRedirect(location)} replace />;
  }

  return <Outlet />;
}
