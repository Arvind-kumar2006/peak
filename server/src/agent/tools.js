// The MCP server the agent uses (mounted on this server at /mcp, bearer-token auth, stateless
// Streamable HTTP). Read tools investigate one incident's service; submit_diagnosis
// records the report; revert_commit is the only write and is gated twice: TrueForge
// pauses it for approval, and it refuses to run unless PEAK recorded that approval.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { adapters } from '../integrations/index.js';
import { getIncident, getService, listSamples, updateIncident, addEvent, transition, getWorkspaceSettings } from '../store.js';
import { buildPatch, LIMITS } from '../patch.js';
import { startMergeWatch } from '../merges.js';
import { checkHealth } from '../health.js';
import { startVerification } from '../verify.js';
import { publish } from '../events.js';

const MAX_PATCH = 6000;
const MAX_FILE = 12000;
export { buildServer };

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 1) }] });
const fail = (message) => ({ content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true });
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

async function context(incidentId) {
  const incident = await getIncident(incidentId);
  if (!incident) throw new Error(`Unknown incident_id ${incidentId}`);
  const service = await getService(incident.serviceId);
  return { incident, service, ...(await adapters(incident.workspaceId)) };
}

// Wrap a handler: resolve context, log the call on the incident timeline, turn throws into tool errors.
function tool(name, label, handler) {
  return async (args) => {
    let ctx;
    try {
      ctx = await context(args.incident_id);
      const result = await handler(ctx, args);
      await addEvent(ctx.incident.id, 'agent.tool', label(args, result), { tool: name, args });
      publish(ctx.incident.workspaceId);
      return ok(result);
    } catch (err) {
      if (ctx) await addEvent(ctx.incident.id, 'agent.tool_error', `${name} failed`, { tool: name, args, error: err.message });
      return fail(err.message);
    }
  };
}

const id = { incident_id: z.string().describe('The incident id from your instructions') };
const requireGithub = (ctx) => {
  if (!ctx.github) throw new Error('GitHub is not connected for this workspace');
  return ctx.github;
};
const requireSentry = (ctx) => {
  if (!ctx.sentry) throw new Error('Sentry is not connected for this workspace');
  if (!ctx.service.sentryProject) throw new Error(`Service ${ctx.service.name} has no Sentry project configured`);
  return ctx.sentry;
};

function buildServer() {
  const server = new McpServer({ name: 'peak', version: '1.0.0' });
  const read = { readOnlyHint: true };

  server.registerTool(
    'get_incident',
    { description: 'The incident: service, alert signal, start time, recent health/error samples and the release the service reports.', inputSchema: id, annotations: read },
    tool('get_incident', () => 'Read the incident', async ({ incident, service, github }) => ({
      id: incident.id,
      title: incident.title,
      startedAt: incident.startedAt,
      signal: incident.signal,
      service: { name: service.name, healthUrl: service.healthUrl, sentryProject: service.sentryProject, reportedRelease: service.release },
      repository: github?.describe() ?? null,
      samples: (await listSamples(service.id, { since: minutesAgo(30) })).filter((_, i, a) => i % Math.ceil(a.length / 20) === 0 || i === a.length - 1),
    })),
  );

  server.registerTool(
    'list_errors',
    {
      description: 'Sentry issues for this service seen in the last N minutes, most frequent first.',
      inputSchema: { ...id, since_minutes: z.number().int().min(5).max(1440).default(60) },
      annotations: read,
    },
    tool(
      'list_errors',
      (a, r) => `Listed errors in Sentry (${r.issues.length} issue${r.issues.length === 1 ? '' : 's'})`,
      async (ctx, { since_minutes }) => ({ issues: await requireSentry(ctx).listIssues(ctx.service.sentryProject, minutesAgo(since_minutes)) }),
    ),
  );

  server.registerTool(
    'get_error_details',
    { description: 'One Sentry issue: exception type and message, stack frames (newest first), release, tags, counts.', inputSchema: { ...id, issue_id: z.string() }, annotations: read },
    tool('get_error_details', (a, r) => `Read error ${r.title ?? a.issue_id}`, async (ctx, { issue_id }) => requireSentry(ctx).getIssue(issue_id)),
  );

  server.registerTool(
    'list_recent_commits',
    {
      description: 'Commits on the deployed branch in the last N minutes, newest first.',
      inputSchema: { ...id, since_minutes: z.number().int().min(10).max(10080).default(1440), limit: z.number().int().min(1).max(50).default(20) },
      annotations: read,
    },
    tool(
      'list_recent_commits',
      (a, r) => `Checked recent commits (${r.commits.length})`,
      async (ctx, { since_minutes, limit }) => {
        const commits = await requireGithub(ctx).listCommits({ since: minutesAgo(since_minutes), limit });
        return { incidentStartedAt: ctx.incident.startedAt, commits: commits.map((c) => ({ ...c, message: clip(c.message, 300) })) };
      },
    ),
  );

  server.registerTool(
    'get_commit_diff',
    { description: 'A commit: message, author, time and the unified diff of every file it changed.', inputSchema: { ...id, sha: z.string().min(7) }, annotations: read },
    tool(
      'get_commit_diff',
      (a, r) => `Read diff of ${r.sha.slice(0, 7)} — ${r.message.split('\n')[0]}`,
      async (ctx, { sha }) => {
        const c = await requireGithub(ctx).getCommit(sha);
        return { ...c, files: c.files.map((f) => ({ ...f, patch: clip(f.patch, MAX_PATCH) })) };
      },
    ),
  );

  server.registerTool(
    'get_file',
    { description: 'File contents at a ref (default: the deployed branch).', inputSchema: { ...id, path: z.string(), ref: z.string().optional() }, annotations: read },
    tool('get_file', (a) => `Read ${a.path}`, async (ctx, { path, ref }) => {
      const f = await requireGithub(ctx).getFile(path, ref);
      return { ...f, content: clip(f.content, MAX_FILE) };
    }),
  );

  server.registerTool(
    'check_service_health',
    { description: "Check the service's health endpoint right now and count errors in the last minute.", inputSchema: id, annotations: read },
    tool(
      'check_service_health',
      (a, r) => `Checked health: ${r.health?.healthy === false ? 'failing' : r.health ? 'healthy' : 'no health URL'}`,
      async (ctx) => ({
        health: ctx.service.healthUrl ? await checkHealth(ctx.service.healthUrl) : null,
        errorsLastMinute: ctx.sentry && ctx.service.sentryProject ? await ctx.sentry.errorCount(ctx.service.sentryProject, minutesAgo(1)) : null,
      }),
    ),
  );

  server.registerTool(
    'submit_diagnosis',
    {
      description:
        'Submit the root-cause diagnosis and proposed fix. Call exactly once, after investigating and BEFORE revert_commit / apply_patch. The human approver reads this next to the Approve button. If a code fix (patch) is rejected by validation, fix the edits and call again.',
      inputSchema: {
        ...id,
        summary: z.string().min(10).describe('One or two sentences: what is broken and why'),
        root_cause: z.string().min(10).describe('The causal chain from change to symptom'),
        confidence: z.number().min(0).max(1),
        suspect_commit: z
          .object({ sha: z.string().min(7), message: z.string(), author: z.string().optional(), committed_at: z.string().optional() })
          .nullable()
          .describe('The commit that caused it, or null if no commit is responsible'),
        evidence: z.array(z.object({ source: z.string().describe('e.g. sentry, github, health'), detail: z.string() })).min(2),
        proposed_fix: z.object({
          type: z.enum(['revert_commit', 'patch', 'none']),
          sha: z.string().min(7).optional().describe('Required for revert_commit'),
          title: z.string().max(120).optional().describe('For patch: a commit-message style title, e.g. "Send payment_id to the gateway again"'),
          edits: z
            .array(
              z.object({
                path: z.string().describe('Existing file, repo-relative'),
                find: z.string().describe('Exact text currently in the file, unique in it (include a few surrounding lines)'),
                replace: z.string().describe('The new text'),
              }),
            )
            .optional()
            .describe(`For patch: at most ${LIMITS.files} files and ${LIMITS.changedLines} changed lines`),
          reason: z.string(),
          expected_outcome: z.string().optional(),
        }),
      },
      annotations: read,
    },
    tool('submit_diagnosis', (a) => `Diagnosis: ${a.summary}`, async (ctx, report) => {
      const { incident_id, ...diagnosis } = report;
      if (diagnosis.proposed_fix.type === 'revert_commit' && !diagnosis.proposed_fix.sha) throw new Error('proposed_fix.sha is required for revert_commit');
      if (diagnosis.proposed_fix.type === 'revert_commit') {
        // Resolve to the full SHA now, so what the human approves is unambiguous.
        const c = await requireGithub(ctx).getCommit(diagnosis.proposed_fix.sha);
        diagnosis.proposed_fix.sha = c.sha;
        diagnosis.proposed_fix.commit = { sha: c.sha, message: c.message.split('\n')[0], author: c.author, date: c.date, url: c.url, files: c.files.map((f) => f.filename) };
      }
      if (diagnosis.proposed_fix.type === 'patch') {
        // Validate against the branch now so the approver sees the real diff; errors go back to the model.
        const github = requireGithub(ctx);
        const built = await buildPatch(diagnosis.proposed_fix.edits ?? [], async (path) => (await github.getFile(path)).content);
        diagnosis.proposed_fix.title ||= 'Fix from PEAK';
        diagnosis.proposed_fix.preview = { diffs: built.diffs, changedLines: built.changedLines, mode: (await getWorkspaceSettings(ctx.incident.workspaceId)).fixMode };
      }
      await updateIncident(ctx.incident.id, { diagnosis: { ...diagnosis, submittedAt: new Date().toISOString() } });
      const next = {
        revert_commit: `Recorded. Now call revert_commit with sha "${diagnosis.proposed_fix.sha}". It pauses for human approval.`,
        patch: `Recorded (${diagnosis.proposed_fix.preview?.changedLines} changed lines). Now call apply_patch. It pauses for human approval.`,
        none: 'Recorded. No fix proposed: reply with a short summary for the on-call engineer and stop.',
      }[diagnosis.proposed_fix.type];
      return { ok: true, next };
    }),
  );

  server.registerTool(
    'revert_commit',
    {
      description:
        'Revert one commit on the deployed branch (new commit on top; history is not rewritten). WRITE ACTION: pauses for human approval. Only for the commit named in your diagnosis.',
      inputSchema: { ...id, sha: z.string().min(7), reason: z.string() },
      annotations: { destructiveHint: true },
    },
    tool('revert_commit', (a, r) => `Reverted ${a.sha.slice(0, 7)} → new commit ${r.revertSha.slice(0, 7)}`, async (ctx, { sha, reason }) => {
      const { incident } = ctx;
      const planned = incident.diagnosis?.proposed_fix;
      if (planned?.type !== 'revert_commit') throw new Error('No revert was proposed in the diagnosis');
      if (!planned.sha.startsWith(sha) && !sha.startsWith(planned.sha)) throw new Error(`Only the proposed commit ${planned.sha} may be reverted`);
      if (incident.approval?.decision !== 'approved') throw new Error('This fix has not been approved in PEAK');
      if (incident.fix) throw new Error(`Already reverted as ${incident.fix.revertSha}`);
      // Approval moves the incident to fixing; anything else (closed by hand, re-run) means stop.
      if (incident.status !== 'fixing') throw new Error(`Incident is ${incident.status}; the fix can no longer be applied`);

      const result = await requireGithub(ctx).revertCommit(planned.sha, { reason });
      const fix = { type: 'revert_commit', targetSha: planned.sha, commitSha: result.revertSha, ...result, appliedAt: new Date().toISOString() };
      await updateIncident(incident.id, { fix });
      startVerification(incident.id);
      return { ...result, next: 'Fix applied. PEAK is now verifying recovery. Reply with one sentence and stop.' };
    }),
  );

  server.registerTool(
    'apply_patch',
    {
      description:
        'Apply the code fix from your diagnosis (proposed_fix.type "patch"). Takes no code: PEAK applies exactly the edits the human approved. Depending on the workspace it opens a pull request or commits to the branch. WRITE ACTION: pauses for human approval.',
      inputSchema: { ...id, reason: z.string() },
      annotations: { destructiveHint: true },
    },
    tool(
      'apply_patch',
      (a, r) => (r.pullRequest ? `Opened pull request #${r.pullRequest.number}` : `Committed fix ${r.commitSha.slice(0, 7)}`),
      async (ctx, { reason }) => {
        const { incident } = ctx;
        const planned = incident.diagnosis?.proposed_fix;
        if (planned?.type !== 'patch') throw new Error('No code fix was proposed in the diagnosis');
        if (incident.approval?.decision !== 'approved') throw new Error('This fix has not been approved in PEAK');
        if (incident.fix) throw new Error('The fix was already applied');
        if (incident.status !== 'fixing') throw new Error(`Incident is ${incident.status}; the fix can no longer be applied`);

        const github = requireGithub(ctx);
        // Re-apply the approved edits to the branch as it is now; fails cleanly if the code moved.
        const built = await buildPatch(planned.edits, async (path) => (await github.getFile(path)).content);
        const { fixMode } = await getWorkspaceSettings(incident.workspaceId);
        const message = `${planned.title}\n\n${planned.reason}${reason && reason !== planned.reason ? `\n\n${reason}` : ''}\n\nIncident ${incident.id}: ${incident.title}\nApproved in PEAK by ${incident.approval.by}.`;
        const base = { type: 'patch', mode: fixMode, files: Object.keys(built.files), appliedAt: new Date().toISOString() };

        if (fixMode === 'push') {
          const commit = await github.commitFiles({ files: built.files, message });
          await github.moveBranch(commit.sha);
          await updateIncident(incident.id, { fix: { ...base, commitSha: commit.sha, url: commit.url, branch: github.describe().branch } });
          startVerification(incident.id);
          return { commitSha: commit.sha, url: commit.url, next: 'Fix committed. PEAK is now verifying recovery. Reply with one sentence and stop.' };
        }

        const head = `peak/fix-${incident.id.replace(/^inc_/, '')}`;
        const commit = await github.commitFiles({ files: built.files, message });
        await github.createBranch(head, commit.sha);
        const pr = await github.openPullRequest({
          head,
          title: planned.title,
          body: `**Incident:** ${incident.title}\n\n**Root cause:** ${incident.diagnosis.root_cause}\n\n**Fix:** ${planned.reason}\n\nProposed by PEAK and approved by ${incident.approval.by}. PEAK verifies recovery after this is merged and deployed.`,
        });
        await updateIncident(incident.id, { fix: { ...base, commitSha: commit.sha, url: commit.url, branch: head, pullRequest: pr } });
        await transition(incident.id, ['fixing'], 'awaiting_merge');
        startMergeWatch(incident.id);
        return { pullRequest: pr, commitSha: commit.sha, next: `Pull request #${pr.number} opened. PEAK verifies after it is merged. Reply with one sentence and stop.` };
      },
    ),
  );

  return server;
}

// Express handler for POST/GET/DELETE /mcp (auth checked in index.js).
export async function handleMcp(req, res) {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
