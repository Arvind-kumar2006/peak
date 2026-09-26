import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import ErrorBoundary from './ErrorBoundary.jsx';
import { useUser } from '../App.jsx';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { useTheme } from '../theme.js';

const OPEN = ['investigating', 'awaiting_approval', 'fixing', 'awaiting_merge', 'verifying'];

const Icon = ({ d, size = 17 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);
const icons = {
  pulse: <path d="M3 13h4l3-8 4 16 3-8h4" />,
  plug: (
    <>
      <path d="M9 7V3" />
      <path d="M15 7V3" />
      <path d="M6 7h12v4a6 6 0 0 1-12 0V7z" />
      <path d="M12 17v4" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  logout: (
    <>
      <path d="M15 17l5-5-5-5" />
      <path d="M20 12H9" />
      <path d="M12 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7" />
    </>
  ),
};

export function Logo({ size = 18 }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <path d="M3 27 L12.5 8 L18 18 L21.5 12 L29 27 Z" fill="currentColor" />
    </svg>
  );
}

export function BrandMark() {
  return (
    <span className="brand-mark">
      <Logo />
    </span>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const options = [
    ['light', 'Light theme', icons.sun],
    ['dark', 'Dark theme', icons.moon],
    ['system', 'Match system', icons.monitor],
  ];
  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {options.map(([value, label, icon]) => (
        <button key={value} type="button" title={label} aria-label={label} aria-pressed={theme === value} onClick={() => setTheme(value)}>
          <Icon d={icon} size={15} />
        </button>
      ))}
    </div>
  );
}

const TITLES = [
  [/^\/incidents\//, 'Incident'],
  [/^\/setup/, 'Connections'],
  [/^\//, 'Production'],
];

export default function Layout({ children }) {
  const { user, setUser } = useUser();
  const navigate = useNavigate();
  const location = useLocation();
  const { data } = useLive('/overview');
  const open = data?.incidents.filter((i) => OPEN.includes(i.status)).length ?? 0;
  const agent = data?.agent;
  const title = TITLES.find(([re]) => re.test(location.pathname))[1];
  const initials = (user.name || user.email || '?')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0].toUpperCase())
    .join('');

  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' });
    setUser(null);
    navigate('/login');
  };

  return (
    <div className="app">
      <aside className="rail">
        <NavLink to="/" className="rail-brand">
          <BrandMark />
          <span>
            <span className="brand-name">PEAK</span>
            <span className="brand-sub">Incident response</span>
          </span>
        </NavLink>
        <nav className="nav" aria-label="Main">
          <p className="nav-group">Monitor</p>
          <ul>
            <li>
              <NavLink to="/" end>
                <Icon d={icons.pulse} />
                Production
                {open > 0 && <span className="count-pill">{open}</span>}
              </NavLink>
            </li>
          </ul>
          <p className="nav-group">Setup</p>
          <ul>
            <li>
              <NavLink to="/setup">
                <Icon d={icons.plug} />
                Connections
              </NavLink>
            </li>
          </ul>
        </nav>
        <div className="rail-foot">
          {agent && (
            <div className="agent-card">
              <span className={`pulse-dot ${agent.ready ? '' : 'off'}`} aria-hidden="true" />
              <span className="who">
                <strong>{agent.ready ? 'AI investigator online' : 'AI investigator offline'}</strong>
                <span className="detail" title={agent.ready ? agent.providers.join(' → ') : agent.error ?? ''}>
                  {agent.ready ? agent.providers.join(' → ') : 'Connecting to TrueForge…'}
                </span>
              </span>
            </div>
          )}
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="crumb">
            <small>PEAK</small>
            {title}
          </div>
          <ThemeToggle />
          <span className="avatar" title={user.email ?? ''}>
            {initials}
          </span>
          <button type="button" className="icon-btn" title="Sign out" aria-label="Sign out" onClick={signOut}>
            <Icon d={icons.logout} size={16} />
          </button>
        </header>
        <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>
      </div>
    </div>
  );
}
