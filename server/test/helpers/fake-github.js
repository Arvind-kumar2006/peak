// Minimal in-process GitHub REST double: enough of commits, compare and the Git Data API
// for PEAK's liveGithub adapter, including revertCommit.
import http from 'node:http';
import { createHash } from 'node:crypto';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

export async function startFakeGithub({ repo = 'acme/api' } = {}) {
  const commits = new Map(); // sha → { sha, parents, message, files }
  const blobs = new Map();
  const trees = new Map(); // tree sha → files
  let head = null;
  let seq = 0;

  function commit(message, files, parents = head ? [head] : []) {
    const sha = sha1(`${seq++}${message}${JSON.stringify(files)}`);
    commits.set(sha, { sha, parents, message, files });
    head = sha;
    return sha;
  }
  const at = (ref) => commits.get(ref === 'main' ? head : ref) ?? [...commits.values()].find((c) => c.sha.startsWith(ref));
  const diff = (a, b) =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((p) => a[p] !== b[p])
      .map((p) => ({ filename: p, status: a[p] === undefined ? 'added' : b[p] === undefined ? 'removed' : 'modified', additions: 1, deletions: 1, patch: `-${a[p] ?? ''}\n+${b[p] ?? ''}` }));
  const ghCommit = (c) => ({
    sha: c.sha,
    html_url: `https://github.com/${repo}/commit/${c.sha}`,
    commit: { message: c.message, author: { name: 'dev', date: '2026-01-01T00:00:00Z' }, committer: { date: '2026-01-01T00:00:00Z' } },
    parents: c.parents.map((sha) => ({ sha })),
  });

  const R = `/repos/${repo}`;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    const { pathname: p } = new URL(req.url, 'http://x');
    const send = (code, data) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    let m;
    if (p === R) return send(200, { full_name: repo, default_branch: 'main', permissions: { push: true } });
    if (p === `${R}/git/ref/heads/main`) return send(200, { object: { sha: head } });
    if (p === `${R}/branches/main`) return send(200, { name: 'main', commit: { sha: head } });
    if ((m = new RegExp(`^${R}/commits/(\\w+)$`).exec(p))) {
      const c = at(m[1]);
      if (!c) return send(404, { message: 'No commit found' });
      return send(200, { ...ghCommit(c), files: diff(c.parents[0] ? at(c.parents[0]).files : {}, c.files) });
    }
    if ((m = new RegExp(`^${R}/compare/(\\w+)\\.\\.\\.(\\w+)$`).exec(p))) return send(200, { files: diff(at(m[1]).files, at(m[2]).files) });
    if ((m = new RegExp(`^${R}/git/trees/(\\w+)$`).exec(p))) {
      return send(200, {
        truncated: false,
        tree: Object.entries(at(m[1]).files).map(([path, content]) => {
          blobs.set(sha1(content), content);
          return { path, mode: '100644', type: 'blob', sha: sha1(content) };
        }),
      });
    }
    if ((m = new RegExp(`^${R}/git/commits/(\\w+)$`).exec(p))) return send(200, { sha: m[1], tree: { sha: `tree-${m[1]}` } });
    if (p === `${R}/git/trees` && req.method === 'POST') {
      const files = { ...at(body.base_tree.replace('tree-', '')).files };
      for (const e of body.tree) {
        if (e.sha === null) delete files[e.path];
        else files[e.path] = blobs.get(e.sha);
      }
      const sha = sha1(JSON.stringify(files));
      trees.set(sha, files);
      return send(201, { sha });
    }
    if (p === `${R}/git/commits` && req.method === 'POST') {
      const sha = sha1(`${seq++}${body.message}`);
      commits.set(sha, { sha, parents: body.parents, message: body.message, files: trees.get(body.tree) });
      return send(201, { sha });
    }
    if (p === `${R}/git/refs/heads/main` && req.method === 'PATCH') {
      head = body.sha;
      return send(200, { object: { sha: head } });
    }
    send(404, { message: `fake github: no route ${req.method} ${p}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    repo,
    commit,
    // Add a commit with two parents (a merge).
    merge: (message, files, otherParent) => commit(message, files, [head, otherParent]),
    head: () => head,
    files: (ref = 'main') => at(ref).files,
    message: (ref = 'main') => at(ref).message,
    close: () => server.close(),
  };
}
