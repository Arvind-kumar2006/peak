import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { Logo } from '../components/Layout.jsx';
import { ErrorNote } from '../components/ui.jsx';

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
      <div className="auth-box">
        <Logo />
        <h1>{signup ? 'Create your account' : 'Sign in'}</h1>
        <p className="muted">AI incident response: detect, investigate, fix with your approval, verify.</p>
        {github && (
          <>
            <a className="button secondary block" href="/api/auth/github">
              Continue with GitHub
            </a>
            <div className="divider">or</div>
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
            <input type="email" value={form.email} onChange={set('email')} autoComplete="email" required />
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
        <p className="muted small">
          {signup ? (
            <>
              Have an account? <Link to="/login">Sign in</Link>
            </>
          ) : (
            <>
              New to PEAK? <Link to="/signup">Create an account</Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
