// Live GitHub adapter (REST API, token = fine-grained PAT with Contents: read & write).
import { config } from '../config.js';

export function githubClient(token) {
  return async function gh(method, path, body) {
    const res = await fetch(`${config.github.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'peak-incident-agent',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        msg = JSON.parse(text).message ?? text;
      } catch {}
      throw new Error(`GitHub ${method} ${path.split('?')[0]} → ${res.status}: ${msg}`);
    }
    return text ? JSON.parse(text) : null;
  };
}

export function liveGithub({ token, repo, branch }) {
  const gh = githubClient(token);
  const R = `/repos/${repo}`;
  const toCommit = (c) => ({
    sha: c.sha,
    message: c.commit.message,
    author: c.commit.author?.name ?? c.author?.login ?? 'unknown',
    date: c.commit.committer?.date ?? c.commit.author?.date,
    url: c.html_url,
  });

  return {
    mode: 'live',
    describe: () => ({ repo, branch, mode: 'live' }),
    async headSha() {
      return (await gh('GET', `${R}/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha;
    },
    async listCommits({ since, limit = 20 } = {}) {
      const qs = new URLSearchParams({ sha: branch, per_page: String(Math.min(limit, 100)), ...(since ? { since } : {}) });
      return (await gh('GET', `${R}/commits?${qs}`)).map(toCommit);
    },
    async getCommit(sha) {
      const c = await gh('GET', `${R}/commits/${sha}`);
      return {
        ...toCommit(c),
        parents: c.parents.map((p) => p.sha),
        files: (c.files ?? []).map((f) => ({
          filename: f.filename,
          previousFilename: f.previous_filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch ?? '(binary or too large to show)',
        })),
      };
    },
    async getFile(path, ref) {
      const qs = ref ? `?ref=${encodeURIComponent(ref)}` : `?ref=${encodeURIComponent(branch)}`;
      const f = await gh('GET', `${R}/contents/${path.split('/').map(encodeURIComponent).join('/')}${qs}`);
      if (Array.isArray(f) || f.type !== 'file') throw new Error(`${path} is not a file`);
      return { path, ref: ref ?? branch, content: Buffer.from(f.content, 'base64').toString('utf8') };
    },

    // GitHub has no "revert" endpoint, so build the revert with the Git Data API:
    // take the branch tip's tree and put back the parent's version of every file the
    // target commit touched. Refuses if a later commit changed the same files (would
    // need a real merge — a human should do that).
    async revertCommit(sha, { reason } = {}) {
      const target = await gh('GET', `${R}/commits/${sha}`);
      if (target.parents.length !== 1) throw new Error('Only commits with exactly one parent can be auto-reverted');
      const parentSha = target.parents[0].sha;
      const tipSha = (await gh('GET', `${R}/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha;

      const touched = new Set(target.files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)));
      if (tipSha !== target.sha) {
        const cmp = await gh('GET', `${R}/compare/${target.sha}...${tipSha}`);
        const overlap = (cmp.files ?? []).map((f) => f.filename).filter((p) => touched.has(p));
        if (overlap.length) throw new Error(`Cannot auto-revert: later commits also changed ${overlap.join(', ')}`);
      }

      const parentTree = await gh('GET', `${R}/git/trees/${parentSha}?recursive=1`);
      if (parentTree.truncated) throw new Error('Repository tree too large to revert automatically');
      const inParent = new Map(parentTree.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e]));
      const entries = [...touched].map((path) => {
        const old = inParent.get(path);
        return old ? { path, mode: old.mode, type: 'blob', sha: old.sha } : { path, mode: '100644', type: 'blob', sha: null };
      });

      const tip = await gh('GET', `${R}/git/commits/${tipSha}`);
      const tree = await gh('POST', `${R}/git/trees`, { base_tree: tip.tree.sha, tree: entries });
      const firstLine = target.commit.message.split('\n')[0];
      const message = `Revert "${firstLine}"\n\nThis reverts commit ${target.sha}.${reason ? `\n\n${reason}` : ''}\n\nApproved in PEAK.`;
      const commit = await gh('POST', `${R}/git/commits`, { message, tree: tree.sha, parents: [tipSha] });
      await gh('PATCH', `${R}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: false });
      return { revertSha: commit.sha, url: `https://github.com/${repo}/commit/${commit.sha}`, branch, files: [...touched] };
    },
  };
}
