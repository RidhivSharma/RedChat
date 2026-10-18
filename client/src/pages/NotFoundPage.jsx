import { Link } from 'react-router-dom';
import BrandLogo from '../components/BrandLogo.jsx';
import { usePageTitle } from '../hooks/usePageTitle.js';

export default function NotFoundPage() {
  usePageTitle('Page not found');

  return (
    <main className="not-found">
      <BrandLogo size={52} />
      <p className="not-found__code">404</p>
      <h1 className="not-found__title">This page went off the wave</h1>
      <p className="not-found__text">
        The page you are looking for does not exist or may have been moved.
      </p>
      <Link className="btn btn--primary" to="/">
        Back to your chats
      </Link>
    </main>
  );
}
