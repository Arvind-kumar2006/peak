import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { Badge, Card, ErrorNote } from '../components/ui.jsx';
import { SERVICE_STATUS } from '../format.js';

// GitHub and Slack connect over OAuth: the user authorizes in the browser, PEAK receives the
// credential, and the only thing left to pick is a target — a repository, a channel. Nothing is
// pasted. Sentry is the exception: its API has no equivalent install flow, so it takes a token.
const OAUTH = {
  github: {
    title: 'GitHub',
    what: 'PEAK reads recent commits and diffs, and reverts the bad commit once you approve.',
    connect: 'Connect with GitHub',
    blurb: "You'll authorize PEAK on GitHub, then choose one repository you can push to.",
    missing: 'GitHub isn’t configured on this server.',
    fix: 'Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, then reload.',
    summary: (s) => `${s.repo} · ${s.branch}${s.login ? ` · via @${s.login}` : ''}`,
  },
  slack: {
    title: 'Slack',
    what: 'PEAK posts the incident, root cause and proposed fix, and updates the message when it resolves.',
    connect: 'Connect with Slack',
    blurb: "You'll install the PEAK app on your Slack workspace, then choose the channel it posts to.",
    missing: 'Slack isn’t configured on this server.',
    fix: 'Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET, then reload.',
    summary: (s) => `#${s.channelName ?? s.channel}${s.team ? ` · ${s.team}` : ''}`,
  },
};

// Both flows land back on /setup?github=… / ?slack=…. Read the flag once, then scrub it so a
// reload doesn't replay an error the user has already seen.
function useLandingError(name) {
  const [params, setParams] = useSearchParams();
  const [failed] = useState(() => params.get(name) === 'error');
  useEffect(() => {
    if (!params.has(name)) return;
    params.delete(name);
    setParams(params, { replace: true });
  }, []);
  return failed ? new Error(name === 'slack' ? 'Slack installation failed or was cancelled. Try again.' : 'GitHub authorization failed or was cancelled. Try again.') : null;
}

const SOURCES = {
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

// The connected state of an OAuth source: what it points at, plus Change (re-authorize, which
// starts the browser flow again) and Disconnect.
function Connected({ kind, integration, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return (
    <>
      <div className="row between">
        <code>{OAUTH[kind].summary(integration.settings)}</code>
        <div className="row">
          <a className="button ghost small" href={`/api/integrations/${kind}/authorize`}>
            Change
          </a>
          <button
            className="outline-danger small"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api(`/integrations/${kind}`, { method: 'DELETE' });
                onChange();
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? '…' : 'Disconnect'}
          </button>
        </div>
      </div>
      <ErrorNote error={error} />
    </>
  );
}

// Shown when the server has no OAuth app configured for this source, so there is nothing the
// user could usefully click. (While we are still finding out, the card shows "Loading…".)
function NotConfigured({ kind }) {
  return (
    <p className="error-note">
      {OAUTH[kind].missing} {OAUTH[kind].fix}
    </p>
  );
}

function GithubCard({ integration, onChange }) {
  const [oauth, setOauth] = useState(null); // is OAuth configured on the server
  const [pending, setPending] = useState(null); // { login } after authorizing
  const [repos, setRepos] = useState(null);
  const [branches, setBranches] = useState([]);
  const [pick, setPick] = useState({ repo: '', branch: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(useLandingError('github'));
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

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/integrations/github', { method: 'PUT', body: { oauth: true, ...pick } });
      setPending(null);
      onChange();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (connected && !pending) {
    body = <Connected kind="github" integration={integration} onChange={onChange} />;
  } else if (pending && repos) {
    body = (
      <form onSubmit={save}>
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
  } else if (oauth) {
    body = (
      <>
        <a className="button" href="/api/integrations/github/authorize">
          {OAUTH.github.connect}
        </a>
        <p className="muted small">{OAUTH.github.blurb}</p>
        <ErrorNote error={error} />
      </>
    );
  } else if (oauth === false) {
    body = <NotConfigured kind="github" />;
  } else {
    body = <p className="muted small">Loading…</p>;
  }

  return (
    <Card title={OAUTH.github.title} actions={connected ? <Badge tone="good">Connected</Badge> : <Badge>Not connected</Badge>} className="source">
      <p className="muted small">{OAUTH.github.what}</p>
      {body}
    </Card>
  );
}

function SlackCard({ integration, onChange }) {
  const [oauth, setOauth] = useState(null); // is the Slack app configured on the server
  const [pending, setPending] = useState(null); // { team } after installing the app
  const [channels, setChannels] = useState(null);
  const [channel, setChannel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(useLandingError('slack'));
  const connected = integration?.connected;

  useEffect(() => {
    api('/auth/providers').then((p) => setOauth(p.slack)).catch(() => setOauth(false));
    api('/integrations/slack/pending')
      .then((p) => {
        setPending(p);
        if (!p) return;
        return api('/integrations/slack/channels').then((list) => {
          setChannels(list);
          // Prefer a channel the bot is already in — posting there is certain to work.
          const first = list.find((c) => c.member) ?? list[0];
          if (first) setChannel(first.id);
        });
      })
      .catch(setError);
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/integrations/slack', { method: 'PUT', body: { oauth: true, channel, channelName: channels.find((c) => c.id === channel)?.name } });
      setPending(null);
      onChange();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (connected && !pending) {
    body = <Connected kind="slack" integration={integration} onChange={onChange} />;
  } else if (pending && channels) {
    body = (
      <form onSubmit={save}>
        <p className="small">
          PEAK was installed on <strong>{pending.team ?? 'your Slack workspace'}</strong>. Pick the channel it should post incidents to.
        </p>
        {channels.length === 0 ? (
          <p className="error-note">
            No channels are visible to the PEAK app. Check that its <code>channels:read</code> and <code>groups:read</code> scopes are approved, then reinstall it.
          </p>
        ) : (
          <label>
            Channel
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                  {c.private ? ' (private)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="muted small">PEAK joins the channel itself, so there is nothing to invite. A private channel still needs the PEAK app added to it in Slack.</p>
        <ErrorNote error={error} />
        <div className="row">
          <button disabled={busy || !channels.length}>{busy ? 'Connecting…' : 'Use this channel'}</button>
          <a className="button ghost" href="/api/integrations/slack/authorize">
            Switch workspace
          </a>
        </div>
      </form>
    );
  } else if (oauth) {
    body = (
      <>
        <a className="button" href="/api/integrations/slack/authorize">
          {OAUTH.slack.connect}
        </a>
        <p className="muted small">{OAUTH.slack.blurb}</p>
        <ErrorNote error={error} />
      </>
    );
  } else if (oauth === false) {
    body = <NotConfigured kind="slack" />;
  } else {
    body = <p className="muted small">Loading…</p>;
  }

  return (
    <Card title={OAUTH.slack.title} actions={connected ? <Badge tone="good">Connected</Badge> : <Badge>Not connected</Badge>} className="source">
      <p className="muted small">{OAUTH.slack.what}</p>
      {body}
    </Card>
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
        <SlackCard integration={byKind.slack} onChange={reload} />
        <SourceCard kind="sentry" integration={byKind.sentry} onChange={reload} />
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
