import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { Badge, Card, ErrorNote } from '../components/ui.jsx';
import { SERVICE_STATUS } from '../format.js';

const SOURCES = {
  github: {
    title: 'GitHub',
    what: 'PEAK reads recent commits and diffs, and reverts the bad commit once you approve.',
    fields: [
      { key: 'repo', label: 'Repository', placeholder: 'owner/repo' },
      { key: 'branch', label: 'Deployed branch', placeholder: 'default branch', optional: true },
      { key: 'token', label: 'Access token', type: 'password', placeholder: 'github_pat_…' },
    ],
    help: 'Fine-grained personal access token for this repository with Contents: read and write, and Metadata: read.',
    summary: (s) => `${s.repo} · ${s.branch}${s.login ? ` · via @${s.login}` : ''}`,
  },
  sentry: {
    title: 'Sentry',
    what: 'PEAK watches the error rate, and reads issues and stack traces during an investigation.',
    fields: [
      { key: 'org', label: 'Organization slug', placeholder: 'acme' },
      { key: 'token', label: 'Auth token', type: 'password', placeholder: 'sntryu_…' },
      { key: 'url', label: 'Sentry URL', placeholder: 'https://sentry.io', optional: true },
    ],
    help: 'User auth token with scopes project:read, event:read and org:read (Settings → Auth Tokens). EU region: https://de.sentry.io.',
    summary: (s) => `${s.org} · ${s.projects?.length ?? 0} projects`,
  },
  slack: {
    title: 'Slack',
    what: 'PEAK posts the incident, root cause and proposed fix, and updates the message when it resolves.',
    fields: [
      { key: 'botToken', label: 'Bot token', type: 'password', placeholder: 'xoxb-…', optional: true },
      { key: 'channel', label: 'Channel', placeholder: '#incidents or channel ID', optional: true },
      { key: 'webhookUrl', label: 'Or: incoming webhook URL', type: 'password', placeholder: 'https://hooks.slack.com/services/…', optional: true },
    ],
    help: 'A bot token (chat:write, bot invited to the channel) lets PEAK update one message per incident. A webhook only posts new messages.',
    summary: (s) => s.channel,
  },
};

function SourceCard({ kind, integration, onChange }) {
  const src = SOURCES[kind];
  const [form, setForm] = useState({});
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const connected = integration?.connected;

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/integrations/${kind}`, { method: 'PUT', body: form });
      setEditing(false);
      setForm({});
      onChange();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    await api(`/integrations/${kind}`, { method: 'DELETE' });
    onChange();
  };

  return (
    <Card
      title={src.title}
      actions={connected ? <Badge tone="good">Connected</Badge> : <Badge>Not connected</Badge>}
      className="source"
    >
      <p className="muted small">{src.what}</p>
      {connected && !editing ? (
        <div className="row between">
          <code>{src.summary(integration.settings)}</code>
          <div className="row">
            <button className="ghost small" onClick={() => setEditing(true)}>
              Change
            </button>
            <button className="outline-danger small" onClick={remove}>
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={save}>
          {src.fields.map((f) => (
            <label key={f.key}>
              {f.label}
              {f.optional && <span className="muted"> (optional)</span>}
              <input type={f.type ?? 'text'} placeholder={f.placeholder} value={form[f.key] ?? ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} autoComplete="off" />
            </label>
          ))}
          <p className="muted small">{src.help}</p>
          <ErrorNote error={error} />
          <div className="row">
            <button disabled={busy}>{busy ? 'Checking…' : 'Connect'}</button>
            {editing && (
              <button type="button" className="ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
    </Card>
  );
}

// GitHub is connected per user: OAuth (pick one of your repos) or, as a fallback, a token.
function GithubCard({ integration, onChange }) {
  const [params, setParams] = useSearchParams();
  const [oauth, setOauth] = useState(null); // is OAuth configured on the server
  const [pending, setPending] = useState(null); // { login } after authorizing
  const [repos, setRepos] = useState(null);
  const [branches, setBranches] = useState([]);
  const [pick, setPick] = useState({ repo: '', branch: '' });
  const [useToken, setUseToken] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(params.get('github') === 'error' ? new Error('GitHub authorization failed or was cancelled. Try again.') : null);
  const connected = integration?.connected;

  useEffect(() => {
    api('/auth/providers').then((p) => setOauth(p.github)).catch(() => setOauth(false));
    api('/integrations/github/pending')
      .then((p) => {
        setPending(p);
        if (!p) return;
        return api('/integrations/github/repos').then((list) => {
          setRepos(list);
          if (list[0]) setPick({ repo: list[0].fullName, branch: list[0].defaultBranch });
        });
      })
      .catch(setError);
  }, []);

  useEffect(() => {
    if (!pending || !pick.repo) return;
    api(`/integrations/github/branches?repo=${encodeURIComponent(pick.repo)}`).then(setBranches).catch(() => setBranches([]));
  }, [pending, pick.repo]);

  const clearParam = () => {
    if (params.get('github')) {
      params.delete('github');
      setParams(params, { replace: true });
    }
  };
  const save = async (body) => {
    setBusy(true);
    setError(null);
    try {
      await api('/integrations/github', { method: 'PUT', body });
      setPending(null);
      setEditing(false);
      setUseToken(false);
      clearParam();
      onChange();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    await api('/integrations/github', { method: 'DELETE' });
    onChange();
  };

  let body;
  if (pending && repos) {
    body = (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save({ oauth: true, ...pick });
        }}
      >
        <p className="small">
          Signed in to GitHub as <strong>@{pending.login}</strong>. Pick the repository your service deploys from.
        </p>
        {repos.length === 0 ? (
          <p className="error-note">@{pending.login} has no repositories with write access.</p>
        ) : (
          <>
            <label>
              Repository
              <select value={pick.repo} onChange={(e) => setPick({ repo: e.target.value, branch: repos.find((r) => r.fullName === e.target.value)?.defaultBranch ?? '' })}>
                {repos.map((r) => (
                  <option key={r.fullName} value={r.fullName}>
                    {r.fullName}
                    {r.private ? ' 🔒' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Deployed branch
              <select value={pick.branch} onChange={(e) => setPick({ ...pick, branch: e.target.value })}>
                {(branches.length ? branches : [pick.branch]).map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </label>
          </>
        )}
        <ErrorNote error={error} />
        <div className="row">
          <button disabled={busy || !repos.length}>{busy ? 'Checking…' : 'Use this repository'}</button>
          <a className="button ghost" href="/api/integrations/github/authorize">
            Switch account
          </a>
        </div>
      </form>
    );
  } else if (connected && !editing) {
    body = (
      <div className="row between">
        <code>{SOURCES.github.summary(integration.settings)}</code>
        <div className="row">
          <button className="ghost small" onClick={() => setEditing(true)}>
            Change
          </button>
          <button className="outline-danger small" onClick={remove}>
            Disconnect
          </button>
        </div>
      </div>
    );
  } else if (oauth && !useToken) {
    body = (
      <>
        <a className="button" href="/api/integrations/github/authorize">
          Connect with GitHub
        </a>
        <p className="muted small">
          You'll authorize PEAK on GitHub, then choose one repository you can push to.{' '}
          <button type="button" className="ghost small" onClick={() => setUseToken(true)}>
            Use a personal access token instead
          </button>
        </p>
        <ErrorNote error={error} />
        {editing && (
          <button className="ghost small" onClick={() => setEditing(false)}>
            Cancel
          </button>
        )}
      </>
    );
  } else {
    body = <TokenForm kind="github" save={(form) => save(form)} busy={busy} error={error} onCancel={editing || useToken ? () => (setEditing(false), setUseToken(false)) : null} />;
  }

  return (
    <Card title="GitHub" actions={connected ? <Badge tone="good">Connected</Badge> : <Badge>Not connected</Badge>} className="source">
      <p className="muted small">{SOURCES.github.what}</p>
      {oauth === false && !connected && <p className="muted small">GitHub OAuth isn't configured on this server, so connect with a personal access token.</p>}
      {body}
    </Card>
  );
}

function TokenForm({ kind, save, busy, error, onCancel }) {
  const src = SOURCES[kind];
  const [form, setForm] = useState({});
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(form);
      }}
    >
      {src.fields.map((f) => (
        <label key={f.key}>
          {f.label}
          {f.optional && <span className="muted"> (optional)</span>}
          <input type={f.type ?? 'text'} placeholder={f.placeholder} value={form[f.key] ?? ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} autoComplete="off" />
        </label>
      ))}
      <p className="muted small">{src.help}</p>
      <ErrorNote error={error} />
      <div className="row">
        <button disabled={busy}>{busy ? 'Checking…' : 'Connect'}</button>
        {onCancel && (
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function ServiceForm({ initial, projects, onDone, onCancel }) {
  const [form, setForm] = useState(initial ?? { name: '', healthUrl: '', sentryProject: '', latencyThresholdMs: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(initial?.id ? `/services/${initial.id}` : '/services', { method: initial?.id ? 'PUT' : 'POST', body: form });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="service-form" onSubmit={save}>
      <div className="grid3">
        <label>
          Name
          <input value={form.name} onChange={set('name')} placeholder="API" required />
        </label>
        <label>
          Health URL
          <input value={form.healthUrl ?? ''} onChange={set('healthUrl')} placeholder="https://api.example.com/health" />
        </label>
        <label>
          Sentry project
          {projects?.length ? (
            <select value={form.sentryProject ?? ''} onChange={set('sentryProject')}>
              <option value="">None</option>
              {projects.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          ) : (
            <input value={form.sentryProject ?? ''} onChange={set('sentryProject')} placeholder="project slug" />
          )}
        </label>
      </div>
      <label className="narrow">
        Alert when slower than (ms)<span className="muted"> (optional)</span>
        <input type="number" min="50" step="1" value={form.latencyThresholdMs ?? ''} onChange={set('latencyThresholdMs')} placeholder="e.g. 2000" />
      </label>
      <p className="muted small">
        If the health endpoint returns JSON with a <code>release</code>, <code>commit</code> or <code>sha</code> field, PEAK also confirms the fix actually deployed.
      </p>
      <ErrorNote error={error} />
      <div className="row">
        <button disabled={busy}>{busy ? 'Saving…' : initial?.id ? 'Save' : 'Add service'}</button>
        {onCancel && (
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export default function Setup() {
  const { data, reload } = useLive('/overview');
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  if (!data) return <div className="center muted">Loading…</div>;

  const byKind = Object.fromEntries(data.integrations.map((i) => [i.kind, i]));
  const projects = byKind.sentry?.settings?.projects;

  const remove = async (id) => {
    await api(`/services/${id}`, { method: 'DELETE' });
    reload();
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Setup</p>
          <h1>Connections</h1>
          <p className="page-copy">Connect your code, your errors and your team's channel, then tell PEAK which services to watch. Each person connects their own accounts.</p>
        </div>
        {data.setupComplete && (
          <Link className="button" to="/">
            Go to dashboard →
          </Link>
        )}
      </div>

      <div className="sources">
        <GithubCard integration={byKind.github} onChange={reload} />
        {['sentry', 'slack'].map((k) => (
          <SourceCard key={k} kind={k} integration={byKind[k]} onChange={reload} />
        ))}
      </div>

      <Card title="Services" actions={!adding && data.services.length > 0 && <button className="small" onClick={() => setAdding(true)}>Add service</button>}>
        {data.services.length === 0 || adding ? (
          <ServiceForm
            projects={projects}
            onDone={() => {
              setAdding(false);
              reload();
            }}
            onCancel={data.services.length ? () => setAdding(false) : null}
          />
        ) : null}
        {data.services.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Service</th>
                <th>Health URL</th>
                <th>Sentry project</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.services.map((s) =>
                editing === s.id ? (
                  <tr key={s.id}>
                    <td colSpan={5}>
                      <ServiceForm
                        initial={s}
                        projects={projects}
                        onDone={() => {
                          setEditing(null);
                          reload();
                        }}
                        onCancel={() => setEditing(null)}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td className="mono small">{s.healthUrl ?? '—'}</td>
                    <td className="mono small">
                      {s.sentryProject ?? '—'}
                      {s.latencyThresholdMs && <div className="muted">slow &gt; {s.latencyThresholdMs}ms</div>}
                    </td>
                    <td>
                      <Badge tone={SERVICE_STATUS[s.status]?.tone}>{SERVICE_STATUS[s.status]?.label ?? s.status}</Badge>
                    </td>
                    <td className="right">
                      <button className="ghost small" onClick={() => setEditing(s.id)}>
                        Edit
                      </button>
                      <button className="ghost small danger-text" onClick={() => remove(s.id)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
