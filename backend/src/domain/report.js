// Diagnosis / Resolution parsing.
//
// These used to arrive as JSON in the agent's final message. They no longer do:
// per contracts/backend-api.md, the agent submits them as the *arguments* to
// `submit_diagnosis` and `submit_resolution` on report-mcp, and the backend
// reads them with `getReports()`. That is a better design — a submitted report
// is a recorded, timestamped act rather than something scraped out of prose —
// but it means the parser's job changed from "find JSON in text" to "normalise
// a tool call's arguments".
//
// The leniency stays. `function.arguments` is a JSON *string* in MCP, and a
// truncated or absent one must degrade the dashboard, never 500 the endpoint it
// polls every 2 seconds.
//
// Rule that matters most: **never throw, and never invent a value.** A missing
// confidence stays null and the UI says "unknown". Fabricating a number on stage
// is exactly the failure mode this project argues against.

import { logger } from '../logger.js';

/** contracts/incident-report.schema.json → Resolution.verdict. */
const VERDICT_TO_STATUS = {
  resolved: 'resolved',
  mitigated: 'mitigated',
  not_resolved: 'not_resolved',
  rejected: 'rejected',
};

export const VERDICTS = Object.keys(VERDICT_TO_STATUS);

export function verdictToStatus(verdict) {
  return VERDICT_TO_STATUS[verdict] ?? null;
}

/** contracts/incident-report.schema.json → Diagnosis.rootCause.category. */
const CATEGORIES = new Set(['code', 'infra', 'unknown']);

/** MCP sends tool arguments as a JSON string. Accept either. */
function toObject(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) return null; // typeof [] === 'object'; not a report
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    // Same trap one level down: JSON.parse('[]') is an object.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Diagnosis — available at `awaiting_approval`, and the thing the human is
 * actually approving.
 */
export function extractDiagnosis(raw) {
  const d = toObject(raw);
  if (!d) {
    if (raw != null) logger.warn('submit_diagnosis args were not readable JSON');
    return null;
  }
  const rootCause = d.rootCause ?? {};
  const proposedFix = d.proposedFix ?? {};
  const category = str(rootCause.category);
  return {
    summary: str(d.summary),
    rootCause: {
      // Anything outside the schema enum degrades to `unknown` rather than
      // reaching the UI, where the category drives the code-vs-infra colour.
      category: CATEGORIES.has(category) ? category : 'unknown',
      description: str(rootCause.description),
      confidence: num(rootCause.confidence),
      commitSha: str(rootCause.commitSha),
    },
    evidence: Array.isArray(d.evidence) ? d.evidence : [],
    // New in the current schema, and the most persuasive field on the card:
    // what the agent considered and threw away.
    ruledOut: Array.isArray(d.ruledOut) ? d.ruledOut.filter((x) => typeof x === 'string') : [],
    proposedFix: {
      action: str(proposedFix.action) ?? 'none',
      args: proposedFix.args && typeof proposedFix.args === 'object' ? proposedFix.args : {},
      reasoning: str(proposedFix.reasoning),
      expectedOutcome: str(proposedFix.expectedOutcome),
    },
    // Baseline metrics captured before the action. Pairs with Resolution.after
    // to give the before/after the agent itself measured.
    before: d.before && typeof d.before === 'object' ? d.before : null,
  };
}

/**
 * Resolution — available at the end. Its `verdict` is the only thing that sets
 * an incident's terminal status; nothing in this codebase decides that.
 */
export function extractResolution(raw) {
  const r = toObject(raw);
  if (!r) {
    if (raw != null) logger.warn('submit_resolution args were not readable JSON');
    return null;
  }
  return {
    verdict: str(r.verdict),
    actionTaken: str(r.actionTaken) ?? 'none',
    windowSec: num(r.windowSec),
    before: r.before && typeof r.before === 'object' ? r.before : null,
    after: r.after && typeof r.after === 'object' ? r.after : null,
    reasoning: str(r.reasoning),
    // New in the current schema. Aims the "and now what" part of the pitch at
    // a real next step instead of trailing off.
    followUp: str(r.followUp),
  };
}

/** True once the agent has submitted a resolution we could read. */
export function hasResolution(resolution) {
  return Boolean(resolution && verdictToStatus(resolution.verdict));
}
