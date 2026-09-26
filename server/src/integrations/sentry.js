// Live Sentry adapter (auth token with project:read, event:read, org:read).
export function liveSentry({ token, org, url = 'https://sentry.io' }) {
  const base = url.replace(/\/+$/, '');

  async function api(path) {
    const res = await fetch(path.startsWith('http') ? path : `${base}/api/0${path}`, { headers: { authorization: `Bearer ${token}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(`Sentry GET ${path.split('?')[0]} → ${res.status}: ${text.slice(0, 200)}`);
    return { body: text ? JSON.parse(text) : null, link: res.headers.get('link') ?? '' };
  }
  const nextPage = (link) => /<([^>]+)>;\s*rel="next";\s*results="true"/.exec(link)?.[1] ?? null;

  const toFrames = (event) => {
    const exc = (event.entries ?? []).find((e) => e.type === 'exception');
    const value = exc?.data?.values?.at(-1);
    return (value?.stacktrace?.frames ?? [])
      .slice(-15)
      .reverse()
      .map((f) => ({
        file: f.filename ?? f.absPath,
        line: f.lineNo,
        function: f.function,
        inApp: f.inApp,
        code: f.context?.find(([n]) => n === f.lineNo)?.[1]?.trim(),
      }));
  };

  return {
    mode: 'live',
    describe: () => ({ org, mode: 'live' }),
    async listProjects() {
      return (await api(`/organizations/${org}/projects/`)).body.map((p) => p.slug);
    },
    // Events newer than `since`. Pages newest-first; stops once it passes `since` (max 5 pages).
    async errorCount(project, since) {
      let path = `/projects/${org}/${project}/events/?full=false`;
      let n = 0;
      for (let page = 0; path && page < 5; page++) {
        const { body, link } = await api(path);
        const fresh = body.filter((e) => e.dateCreated >= since);
        n += fresh.length;
        if (fresh.length < body.length) break;
        path = nextPage(link);
      }
      return n;
    },
    async listIssues(project, since) {
      const qs = new URLSearchParams({ query: 'is:unresolved', statsPeriod: '24h', sort: 'freq', limit: '25' });
      const { body } = await api(`/projects/${org}/${project}/issues/?${qs}`);
      return body
        .filter((i) => i.lastSeen >= since)
        .slice(0, 10)
        .map((i) => ({ id: i.id, title: i.title, culprit: i.culprit, count: Number(i.count), firstSeen: i.firstSeen, lastSeen: i.lastSeen, release: null, url: i.permalink }));
    },
    async getIssue(issueId) {
      const [{ body: issue }, { body: event }] = await Promise.all([api(`/organizations/${org}/issues/${issueId}/`), api(`/organizations/${org}/issues/${issueId}/events/latest/`)]);
      const tags = Object.fromEntries((event.tags ?? []).map((t) => [t.key, t.value]));
      const exc = (event.entries ?? []).find((e) => e.type === 'exception')?.data?.values?.at(-1);
      return {
        id: issue.id,
        title: issue.title,
        type: exc?.type ?? issue.metadata?.type ?? null,
        message: exc?.value ?? issue.metadata?.value ?? event.message ?? null,
        culprit: issue.culprit,
        count: Number(issue.count),
        firstSeen: issue.firstSeen,
        lastSeen: issue.lastSeen,
        releases: [{ release: event.release?.version ?? tags.release ?? null, events: null }],
        frames: toFrames(event),
        tags,
        url: issue.permalink,
      };
    },
  };
}
