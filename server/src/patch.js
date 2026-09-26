// Code fixes proposed by the agent: small, exact find/replace edits on existing files.
// Validated against the branch when proposed (so the human approves a real diff) and applied
// again from the stored edits at approval time (so nothing can change between review and apply).
import { createTwoFilesPatch } from 'diff';

export const LIMITS = { files: 3, changedLines: 60, editsPerFile: 5 };

// Never touched by an automatic fix: CI, dependency manifests/lockfiles, secrets, infra.
const DENY = [
  /^\.github\//,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|package\.json|Gemfile\.lock|poetry\.lock|go\.sum|Cargo\.lock)$/,
  /(^|\/)(Dockerfile|docker-compose\.ya?ml|render\.yaml|vercel\.json|fly\.toml)$/,
  /\.(pem|key|p12|crt)$/,
  /(^|\/)(terraform|infra|k8s|helm)\//,
];

export class PatchError extends Error {}

const count = (haystack, needle) => {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) n++;
  return n;
};

// edits: [{ path, find, replace }] → groups by file and checks shape and limits.
export function checkEdits(edits) {
  if (!Array.isArray(edits) || edits.length === 0) throw new PatchError('A code fix needs at least one edit');
  const byFile = new Map();
  for (const e of edits) {
    const path = String(e.path ?? '').replace(/^\/+/, '');
    if (!path || path.includes('..') || path.includes('\\')) throw new PatchError(`Invalid path: ${e.path}`);
    if (DENY.some((re) => re.test(path))) throw new PatchError(`${path} can't be changed by an automatic fix (CI, dependencies, secrets or infrastructure)`);
    if (typeof e.find !== 'string' || !e.find) throw new PatchError(`Edit to ${path}: "find" must be the exact existing text`);
    if (typeof e.replace !== 'string') throw new PatchError(`Edit to ${path}: "replace" must be a string`);
    if (e.find === e.replace) throw new PatchError(`Edit to ${path} changes nothing`);
    if (!byFile.has(path)) byFile.set(path, []);
    byFile.get(path).push({ find: e.find, replace: e.replace });
  }
  if (byFile.size > LIMITS.files) throw new PatchError(`A code fix may touch at most ${LIMITS.files} files (this one touches ${byFile.size}). Propose something smaller or hand it to a human.`);
  for (const [path, list] of byFile) if (list.length > LIMITS.editsPerFile) throw new PatchError(`At most ${LIMITS.editsPerFile} edits per file (${path} has ${list.length})`);
  return byFile;
}

// Apply one file's edits to its current content. Each "find" must occur exactly once.
export function applyEdits(path, content, list) {
  let out = content;
  for (const { find, replace } of list) {
    const n = count(out, find);
    if (n === 0) throw new PatchError(`In ${path}, the text to replace was not found (the file may have changed): ${JSON.stringify(find.slice(0, 80))}`);
    if (n > 1) throw new PatchError(`In ${path}, the text to replace appears ${n} times; include more surrounding lines so it is unique`);
    out = out.replace(find, () => replace);
  }
  return out;
}

// Unified diff for one file plus its changed-line count.
export function fileDiff(path, before, after) {
  const lines = createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, '', '', { context: 3 }).split('\n');
  // Drop the ===/---/+++ header: the path is shown separately.
  const patch = lines.slice(Math.max(0, lines.findIndex((l) => l.startsWith('@@')))).join('\n').trimEnd();
  const changed = patch.split('\n').filter((l) => (l.startsWith('+') && !l.startsWith('+++')) || (l.startsWith('-') && !l.startsWith('---'))).length;
  return { path, patch, changed };
}

// Build the full result against a content reader ((path) → Promise<string>).
// Returns { files: {path: newContent}, diffs: [{path, patch, changed}], changedLines }.
export async function buildPatch(edits, readFile) {
  const byFile = checkEdits(edits);
  const files = {};
  const diffs = [];
  for (const [path, list] of byFile) {
    let before;
    try {
      before = await readFile(path);
    } catch (err) {
      throw new PatchError(`${path}: ${err.message}. Code fixes can only change existing files.`);
    }
    const after = applyEdits(path, before, list);
    files[path] = after;
    diffs.push(fileDiff(path, before, after));
  }
  const changedLines = diffs.reduce((n, d) => n + d.changed, 0);
  if (changedLines > LIMITS.changedLines) throw new PatchError(`This fix changes ${changedLines} lines; the limit is ${LIMITS.changedLines}. Propose something smaller or hand it to a human.`);
  return { files, diffs, changedLines };
}
