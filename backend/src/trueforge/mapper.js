// TrueForge -> PEAK shape mapping.
//
// Everything TrueForge-shaped is normalised in this one file, so an unexpected
// event shape from the runtime costs us a degraded timeline rather than a 500 on
// the endpoint the dashboard polls every 2 seconds.
//
// The guiding rule: **be liberal in what you accept.** P3 still has an open
// item — "document where the pending tool call's name + args live" — so the
// tool-call extractor below deliberately tries several shapes and returns what
// it finds with a null tool name if it can't. A pending action showing as
// "(tool name unavailable)" is a cosmetic problem. Crashing the approval flow
// is a demo-ending problem.

import { logger } from '../logger.js';

/** Every place a tool call could be hiding inside one event. */
const TOOL_CALL_CONTAINERS = ['tool_calls', 'toolCalls', 'tool_call', 'toolCall'];

function containerOf(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of TOOL_CALL_CONTAINERS) {
    const value = obj[key];
    if (Array.isArray(value) && value.length) return value;
  }
  return null;
}

/** A tool call's name, across the shapes we've seen and can imagine. */
function nameOf(call) {
  return (
    call?.function?.name ??
    call?.tool?.name ??
    call?.name ??
    call?.toolName ??
    null
  );
}

/**
 * A tool call's arguments. MCP sends `arguments` as a JSON *string*; some
 * paths use `args` or `input` as an already-decoded object. Handle all three
 * and never throw on malformed JSON.
 */
function argsOf(call) {
  const raw = call?.function?.arguments ?? call?.arguments ?? call?.args ?? call?.input;
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A truncated or streamed argument string. Surfacing the raw text beats
    // showing an empty object, because "reason": "Error rate 42%..." is still
    // the most useful thing on an approval card.
    return { _raw: raw.slice(0, 500) };
  }
}

/** Give tool calls a stable identity even when the runtime omits one. */
function idOf(call, index) {
  return call?.id ?? call?.tool_call_id ?? call?.toolCallId ?? `call_${index}`;
}

/**
 * Find a specific tool call anywhere in the event list.
 *
 * Searches, in order: direct `tool.call`-style events, then any event carrying
 * a tool_calls array (the `model.message` that `source_event_id` points at).
 */
function findToolCall(events, toolCallId) {
  // Direct event whose own id is the tool call.
  const direct = events.find(
    (e) => e && (e.id === toolCallId) && (e.type === 'tool.call' || e.type === 'tool_call' || e.name || e.tool),
  );
  if (direct) {
    const name = nameOf(direct) ?? direct.name ?? direct.tool;
    if (name) return { id: toolCallId, name, args: argsOf(direct) };
  }

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const calls = containerOf(event) ?? containerOf(event.message) ?? containerOf(event.payload);
    if (!calls) continue;
    for (const [i, call] of calls.entries()) {
      if (idOf(call, i) === toolCallId) {
        return { id: toolCallId, name: nameOf(call), args: argsOf(call) };
      }
    }
  }
  return null;
}

function eventIdOf(event, index) {
  return event?.id ?? `${index}`;
}

/**
 * Build the `pendingAction` for contracts/backend-api.md from the current turn's
 * events, or null when the gate isn't open.
 *
 * Shape: { threadId, toolCallId, tool, args }
 */
export function extractPendingAction(events = []) {
  const gate = [...events].reverse().find((e) => e?.type === 'tool.approval_required');
  if (!gate) return null;

  const threadId = gate.thread_id ?? gate.threadId ?? null;
  const toolCalls = gate.tool_calls ?? gate.toolCalls ?? [];
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    // The gate fired but we can't see what for. Still surface it, so the
    // dashboard can show "approval requested, details unavailable" instead of
    // an Approve button with no context.
    return { threadId, toolCallId: null, tool: null, args: {}, unavailable: true };
  }

  // We render one card per pending call but the contract models a single action,
  // and in practice the agent proposes exactly one fix (SKILL.md). Take the
  // first; `extras` carries any others so nothing is silently dropped.
  const [head, ...rest] = toolCalls;
  const headId = head?.id ?? head?.tool_call_id ?? null;
  const resolved = headId ? findToolCall(events, headId) : null;

  if (!resolved?.name) {
    logger.warn('approval gate fired but the tool name could not be located', {
      toolCallId: headId,
      sourceEventId: head?.source_event_id ?? null,
    });
  }

  const extras = rest.map((c, i) => {
    const id = c?.id ?? c?.tool_call_id ?? null;
    const found = id ? findToolCall(events, id) : null;
    return { toolCallId: id, tool: found?.name ?? null, args: found?.args ?? {} };
  });

  return {
    threadId,
    toolCallId: headId,
    tool: resolved?.name ?? null,
    args: resolved?.args ?? {},
    unavailable: !resolved?.name,
    extras,
  };
}

/**
 * Normalise a raw TrueForge event into what we store and render.
 * `seq` is our ordering key so pagination can resume without duplicates.
 */
export function normaliseEvent(event, index) {
  return {
    eventId: eventIdOf(event, index),
    type: event?.type ?? 'unknown',
    // TrueForge nests the interesting payload differently per event type
    // (state, output, tool_calls...). Keeping the whole raw object means the
    // dashboard timeline can render new event types without a backend change.
    payload: event,
    at: event?.created_at ?? event?.createdAt ?? event?.timestamp ?? new Date().toISOString(),
  };
}

/** Human-readable one-liner for the dashboard timeline. */
export function describeEvent(event) {
  switch (event?.type) {
    case 'turn.started':
    case 'turn.start':
      return 'Investigation turn started';
    case 'model.message':
      return 'Agent produced a message';
    case 'tool.call':
    case 'tool_call':
      return `Called ${nameOf(event) ?? event?.name ?? 'a tool'}`;
    case 'tool.result':
    case 'tool_result':
      return `Tool ${event?.name ?? ''} returned`.trim();
    case 'tool.approval_required':
      return 'Paused: waiting for human approval';
    case 'turn.done':
      return `Turn ${event?.state?.status ?? 'finished'}`;
    default:
      return event?.type ?? 'event';
  }
}
