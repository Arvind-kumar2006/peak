// Code fixes opened as pull requests: poll the PR until it is merged (→ verify recovery
// against the merge commit) or closed unmerged (→ not recovered, a human owns it).
import { config } from './config.js';
import { adapters } from './integrations/index.js';
import { getIncident, addEvent, transition } from './store.js';
import { startVerification } from './verify.js';
import { publish } from './events.js';
import { notify } from './notify.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watching = new Set();

export function startMergeWatch(incidentId) {
  if (watching.has(incidentId)) return;
  watching.add(incidentId);
  watch(incidentId)
    .catch((err) => console.error(`[merges] ${incidentId}: ${err.message}`))
    .finally(() => watching.delete(incidentId));
}

async function watch(incidentId) {
  const deadline = Date.now() + config.merge.timeoutHours * 3600_000;
  let lastError = null;
  for (;;) {
    const incident = await getIncident(incidentId);
    // Closed by hand, re-run, … — stop watching.
    if (incident?.status !== 'awaiting_merge') return;
    const prNumber = incident.fix?.pullRequest?.number;
    if (!prNumber) return;

    try {
      const { github } = await adapters(incident.workspaceId);
      if (!github) throw new Error('GitHub is not connected');
      const pr = await github.getPullRequest(prNumber);
      lastError = null;

      if (pr.merged) {
        const fix = { ...incident.fix, commitSha: pr.mergeCommitSha, mergedAt: new Date().toISOString() };
        const moved = await transition(incidentId, ['awaiting_merge'], 'fixing', { fix });
        if (!moved) return;
        await addEvent(incidentId, 'verify', `Pull request #${prNumber} merged`, { mergeCommitSha: pr.mergeCommitSha });
        publish(incident.workspaceId);
        startVerification(incidentId);
        return;
      }
      if (pr.state === 'closed') {
        const at = new Date().toISOString();
        const reason = `Pull request #${prNumber} was closed without merging`;
        const inc = await transition(incidentId, ['awaiting_merge'], 'unresolved', { verification: { verdict: 'unresolved', reason, finishedAt: at }, resolvedAt: at });
        if (!inc) return;
        await addEvent(incidentId, 'unresolved', reason);
        publish(incident.workspaceId);
        notify(incidentId);
        return;
      }
    } catch (err) {
      // Transient GitHub errors: keep watching, but record the first one of a streak.
      if (lastError !== err.message) await addEvent(incidentId, 'verify.error', 'Could not check the pull request', { error: err.message });
      lastError = err.message;
    }

    if (Date.now() > deadline) {
      const inc = await transition(incidentId, ['awaiting_merge'], 'needs_attention', { resolvedAt: new Date().toISOString() });
      if (inc) {
        await addEvent(incidentId, 'needs_attention', `Pull request #${prNumber} still not merged after ${config.merge.timeoutHours}h; PEAK stopped watching it`);
        publish(incident.workspaceId);
        notify(incidentId);
      }
      return;
    }
    await sleep(config.merge.pollSec * 1000);
  }
}
