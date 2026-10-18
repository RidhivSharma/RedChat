import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth.js';
import FullPageSpinner from './FullPageSpinner.jsx';
import UnlockScreen from './UnlockScreen.jsx';

/**
 * Route wrapper for pages that require a signed-in user.
 * While the session (and the encryption key) is being restored a full-page
 * spinner is shown; once the restore finishes, signed-out visitors are sent to
 * /login (remembering where they wanted to go). A signed-in session without a
 * local private key shows the unlock screen instead of the app — there is no
 * plain-text fallback.
 */
export default function ProtectedRoute() {
  const { user, loading, keyStatus } = useAuth();
  const location = useLocation();

  if (loading || keyStatus === 'loading') {
    return <FullPageSpinner label="Checking your session…" />;
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (keyStatus === 'locked') {
    return <UnlockScreen />;
  }

  return <Outlet />;
}
