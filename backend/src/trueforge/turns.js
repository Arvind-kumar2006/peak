// Reading turn state from a TrueForge session's event log (see contracts/trueforge.md).
// Pure functions — no fetch — so the tricky cases are unit-tested (test/turns.test.mjs).

/**
 * Events of the session's latest turn only.
 *
 * Every decision chains a *new* turn onto the paused one, and TrueForge also
 * ends a paused turn with `turn.done` (status "done", required_actions = the
 * approval). So "is there a turn.done / approval anywhere in the session" is
 * the wrong question: it is true from the moment the agent pauses, which read
 * as "finished without a resolution" → error, and kept offering an approval
 * that had already been decided. Everything below looks at the latest turn.
 */
export function latestTurn(events) {
  const created = events.filter((e) => e?.type === 'turn.created');
  const turnId = created.at(-1)?.turn_id ?? events.at(-1)?.turn_id ?? null;
  return turnId ? events.filter((e) => e?.turn_id === turnId) : events;
}

/**
 * Reconstruct the handle needed to approve, from the event log alone.
 *
 * P3's client returns `paused` from `tf.start()`. Holding that in memory
 * would mean a backend restart mid-incident could never approve it, and
 * `tool.approval_required` carries everything needed: thread id and the
 * pending tool call ids.
 */
export function pausedFrom(events) {
  const gate = latestTurn(events).findLast((e) => e?.type === 'tool.approval_required');
  if (!gate) return null;
  return {
    kind: 'approval',
    turnId: gate.turn_id ?? null,
    threadId: gate.thread_id ?? null,
    toolCalls: gate.tool_calls ?? [],
  };
}

/** The latest turn's terminal event, unless that "terminal" event is really a pause. */
function finishedTurnDone(events) {
  const done = latestTurn(events).findLast((e) => e?.type === 'turn.done');
  if (!done || done.state?.required_actions?.length) return null;
  return done;
}

/** True once the latest turn has finished for real (not paused for approval). */
export function turnDoneFrom(events) {
  return Boolean(finishedTurnDone(events));
}

export function turnStatusFrom(events) {
  return finishedTurnDone(events)?.state?.status ?? null;
}
