// Report parsing. The agent's final answer is JSON (AgentSpec
// response_format: json_schema over contracts/incident-report.schema.json), but
// it arrives as model *text*, so it may be raw JSON, fenced, or wrapped in a
// sentence. This module is deliberately forgiving.
//
// Rule that matters most: **never throw**. A malformed report must degrade the
// dashboard to "couldn't parse this", never 500 the endpoint the judge is
// watching. Every failure path returns null.

import { logger } from '../logger.js';

/** Statuses the report phase can map onto. 1:1 with the schema enum. */
const PHASE_TO_STATUS = {
  diagnosed: 'diagnosed',
  resolved: 'resolved',
  mitigated: 'mitigated',
  not_resolved: 'not_resolved',
  rejected: 'rejected',
};

export function phaseToStatus(phase) {
  return PHASE_TO_STATUS[phase] ?? null;
}

/** Unwrap whatever TrueForge put in `turn.done.state.output` down to text. */
function outputToText(output) {
  if (output == null) return null;
  if (typeof output === 'string') return output;
  if (typeof output === 'object') {
    // Verified shape: { type: "model.message", content: "..." }
    if (typeof output.content === 'string') return output.content;
    // Tolerate a content-parts array rather than a plain string.
    if (Array.isArray(output.content)) {
      return output.content
        .map((p) => (typeof p === 'string' ? p : p?.text ?? ''))
        .join('');
    }
    if (typeof output.text === 'string') return output.text;
  }
  return null;
}

/**
 * Pull the first balanced {...} run out of a string. Used when the model
 * wrapped its JSON in prose ("Here is the report:\n{...}").
 */
function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function tryParse(candidate) {
  if (!candidate) return null;
  try {
    const value = JSON.parse(candidate);
    // Guard against parsing an unrelated JSON blob that happens to be in the
    // text. A real report always has a phase and a rootCause.
    if (value && typeof value === 'object' && (value.phase || value.rootCause)) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Best-effort extraction of an IncidentReport from a finished turn.
 * Returns null when nothing report-shaped can be found.
 */
export function extractReport(output) {
  const text = outputToText(output);
  if (!text) return null;

  // 1. Raw JSON, the happy path.
  const direct = tryParse(text.trim());
  if (direct) return normalise(direct);

  // 2. Fenced block, the common LLM habit.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) {
    const parsed = tryParse(fence[1].trim());
    if (parsed) return normalise(parsed);
  }

  // 3. First balanced object anywhere in the text.
  const embedded = tryParse(firstJsonObject(text));
  if (embedded) return normalise(embedded);

  logger.warn('could not parse an IncidentReport from the final message', {
    preview: text.slice(0, 160),
  });
  return null;
}

/**
 * Fill in optional fields the schema allows to be missing so the dashboard
 * never renders `undefined`. We do NOT invent values — a missing confidence
 * stays null and the UI shows "unknown", because a fabricated 0.9 on stage is
 * exactly the kind of lie this project's whole pitch is arguing against.
 */
function normalise(report) {
  const rootCause = report.rootCause ?? {};
  const proposedFix = report.proposedFix ?? {};
  return {
    phase: report.phase ?? null,
    summary: report.summary ?? null,
    rootCause: {
      category: rootCause.category ?? 'unknown',
      description: rootCause.description ?? null,
      confidence: typeof rootCause.confidence === 'number' ? rootCause.confidence : null,
      commitSha: rootCause.commitSha ?? null,
    },
    evidence: Array.isArray(report.evidence) ? report.evidence : [],
    proposedFix: {
      action: proposedFix.action ?? 'none',
      args: proposedFix.args && typeof proposedFix.args === 'object' ? proposedFix.args : {},
      reasoning: proposedFix.reasoning ?? null,
      diff: proposedFix.diff ?? null,
    },
    verification: report.verification ?? null,
  };
}

export const REPORT_PHASES = Object.keys(PHASE_TO_STATUS);
