import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import ErrorBoundary from './ErrorBoundary.jsx';
import { useUser } from '../App.jsx';
import { api } from '../api.js';

export function Logo() {
  return (
    <span className="logo">
      <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
        <path d="M3 27 L12.5 8 L18 18 L21.5 12 L29 27 Z" fill="currentColor" />
      </svg>
      PEAK
    </span>
  );
}

export default function Layout({ children }) {
  const { user, setUser } = useUser();
  const navigate = useNavigate();
  const location = useLocation();
  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' });
    setUser(null);
    navigate('/login');
  };
  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/" className="brand">
          <Logo />
        </NavLink>
        <nav>
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/setup">Connections</NavLink>
        </nav>
        <div className="spacer" />
        <span className="muted small">{user.name || user.email}</span>
        <button className="ghost small" onClick={signOut}>
          Sign out
        </button>
      </header>
      <main>
        <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>
      </main>
    </div>
  );
}
