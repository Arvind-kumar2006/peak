// TrueForge -> PEAK shape mapping.
//
// Deliberately thin now that the reports come from `submit_diagnosis` /
// `submit_resolution` tool arguments and the pending action comes from P3's
// `getPendingAction()` (contracts/backend-api.md). What remains here is the glue
// between those library-shaped values and the flat API object the dashboard
// consumes — plus the event normalisation the poller stores.
//
// The guiding rule is unchanged: **be liberal in what you accept.** An
// unexpected shape must cost a degraded panel, never a 500 on the endpoint the
// dashboard polls every 2 seconds.

import { logger } from '../logger.js';

/**
 * P3's `getPendingAction()` returns an array of
 * `{toolCallId, threadId, tool, server, args}`. The contract's Incident object
 * models a single action, and the agent proposes exactly one fix, so we take
 * the first and carry any others in `extras` rather than dropping them.
 */
export function pendingActionFrom(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  const [head, ...rest] = actions;
  return {
    threadId: head.threadId ?? null,
    toolCallId: head.toolCallId ?? null,
    tool: head.tool ?? null,
    args: head.args && typeof head.args === 'object' ? head.args : safeParse(head.args) ?? {},
    server: head.server ?? null,
    // The runtime is waiting, but we could not describe what for. The dashboard
    // shows "details unavailable" rather than an Approve button with no context.
    unavailable: !head.tool || !head.toolCallId,
    extras: rest.map((a) => ({ toolCallId: a.toolCallId ?? null, tool: a.tool ?? null, args: a.args ?? {} })),
  };
}

function safeParse(v) {
  if (typeof v !== 'string') return null;
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Normalise a raw event for storage. `seq` ordering comes from the store.
 *
 * The whole raw object is kept as `payload` so the dashboard timeline can render
 * an event type we have never seen without a backend change.
 */
export function normaliseEvent(event, index) {
  return {
    eventId: event?.id ?? `${index}`,
    type: event?.type ?? 'unknown',
    payload: event,
    at: event?.created_at ?? event?.timestamp ?? new Date().toISOString(),
  };
}

/** Human-readable one-liner for the dashboard timeline. */
export function describeEvent(event) {
  switch (event?.type) {
    case 'model.message':
      return event?.tool_calls?.length
        ? `Agent called ${event.tool_calls.map((c) => c.function?.name ?? c.name).filter(Boolean).join(', ')}`
        : 'Agent produced a message';
    case 'tool.response':
      return `${event?.name ?? 'Tool'} responded`;
    case 'tool.approval_required':
      return 'Paused: waiting for human approval';
    case 'turn.done':
      return `Turn ${event?.state?.status ?? 'finished'}`;
    default:
      return event?.type ?? 'event';
  }
}

/** Tool names the report-mcp exposes, used to spot the submitted reports. */
const REPORT_TOOLS = new Set(['submit_diagnosis', 'submit_resolution']);

export function isReportTool(name) {
  return REPORT_TOOLS.has(name);
}

export function warn(message, fields) {
  logger.warn(message, fields);
}
