import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { BrandMark } from '../components/Layout.jsx';
import { ErrorNote } from '../components/ui.jsx';

const LOOP = [
  ['1', 'Detect', 'error spikes, failing or slow health checks'],
  ['2', 'Investigate', 'errors, stack traces, commits and diffs'],
  ['3', 'Approve', 'one proposed fix, on the dashboard or in Slack'],
  ['4', 'Fix', 'a revert commit on your branch'],
  ['5', 'Verify', 'deploy confirmed, errors back to zero'],
];

export default function Auth({ mode, onAuth }) {
  const signup = mode === 'signup';
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [github, setGithub] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    api('/auth/providers').then((p) => setGithub(p.github)).catch(() => {});
    if (new URLSearchParams(location.search).get('error') === 'github') setError(new Error('GitHub sign-in failed. Try again.'));
  }, [location.search]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api(signup ? '/auth/signup' : '/auth/login', { method: 'POST', body: form });
      onAuth(user);
      navigate(signup ? '/setup' : '/');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="auth">
      <section className="auth-story">
        <div className="row">
          <BrandMark />
          <span>
            <span className="brand-name">PEAK</span>
            <span className="brand-sub">Incident response</span>
          </span>
        </div>
        <div>
          <h1>Production breaks. PEAK finds the commit, asks you, fixes it, and proves it.</h1>
          <ol className="loop">
            {LOOP.map(([n, label, detail]) => (
              <li key={n}>
                <span className="n">{n}</span>
                <span>
                  <strong>{label}</strong> — {detail}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <p className="muted small">Connects to GitHub, Sentry and Slack. Nothing changes in production without a human's approval.</p>
      </section>
      <section className="auth-form">
        <div className="auth-box">
          <h1>{signup ? 'Create your account' : 'Sign in'}</h1>
          <p className="muted">{signup ? 'Set up your incident room in a few minutes.' : 'Welcome back to your incident room.'}</p>
          {github && (
            <>
              <a className="button secondary block" href="/api/auth/github" style={{ marginTop: 20 }}>
                Continue with GitHub
              </a>
              <div className="divider">or with email</div>
            </>
          )}
          <form onSubmit={submit}>
            {signup && (
              <label>
                Name
                <input value={form.name} onChange={set('name')} autoComplete="name" />
              </label>
            )}
            <label>
              Email
              <input type="email" value={form.email} onChange={set('email')} autoComplete="email" placeholder="you@company.com" required />
            </label>
            <label>
              Password
              <input type="password" value={form.password} onChange={set('password')} autoComplete={signup ? 'new-password' : 'current-password'} minLength={signup ? 8 : undefined} required />
            </label>
            <ErrorNote error={error} />
            <button className="block" disabled={busy}>
              {busy ? '…' : signup ? 'Create account' : 'Sign in'}
            </button>
          </form>
          <p className="muted small" style={{ marginTop: 16 }}>
            {signup ? (
              <>
                Have an account? <Link className="link" to="/login">Sign in</Link>
              </>
            ) : (
              <>
                New to PEAK? <Link className="link" to="/signup">Create an account</Link>
              </>
            )}
          </p>
        </div>
      </section>
    </div>
  );
}
