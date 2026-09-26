# PEAK — Demo Script

Owner: **P4**. Four minutes. Rehearse against `dashboard`'s **preview** build,
not the dev server.

> Update this as features land. If a step stops being true, fix this file before
> you fix the code — a script that lies is worse than no script.

---

## Before you start (T−10 min)

- [ ] Demo app deployed and healthy — `GET /health` returns `ok`
- [ ] `scripts/start-trueforge.sh` running, UI at `:8790`
- [ ] MCP connectors up (or `MOCK=1`)
- [ ] `backend` up, `GET /api/health` shows `agent.mode: real`
- [ ] `dashboard` built and served via `npm run preview`
- [ ] **Reset the demo**, then confirm `/health` is `ok` and error rate < 1%
- [ ] Backup video playing in a second window, ready to alt-tab
- [ ] Terminal font bumped up. Nobody should be able to see your shell history.

**Know these three numbers cold** — they are the whole demo:

| | |
|---|---|
| Pool | **10 max, 10 in use, 34 waiting** |
| Error rate | **~42%** |
| Bad commit | **`a80e0f0` — "perf: reuse client for order lookup"** |

---

## The script

### 0:00 — The problem (20s)

> "It's 2am. Our service is throwing 500s. We have GitHub, Sentry, Postgres and
> Render. What PEAK does is close the loop: detect, investigate, diagnose,
> propose a fix, **wait for a human to approve it**, then verify it actually
> worked. The approval step is the point — I'll show you where it is."

### 0:20 — Trigger it (15s)

**Click "Scenario A — connection leak".**

> "I just injected the failure. A bad commit is deployed. Watch the top strip."

*Wait ~10s. The live strip degrades: error rate climbs, pool goes to 10/10.*

> "Error rate is 42%. The pool is exhausted. This is a real service, a real
> Postgres pool, a real commit."

### 0:35 — Watch it investigate (40s)

*The feed shows **Investigating**. The event trail fills in.*

> "The agent is working through read-only tools — service status, metrics, pool
> stats, recent commits, Sentry errors. It can't fix anything yet. Everything it
> can do is read-only."

*Scroll to the event trail. Point at the tool names.*

> "Every one of those is a real tool call. This is the full reasoning trail,
> kept by the runtime — not a summary written afterwards."

### 1:15 — The diagnosis (45s)

*The card flips to **Awaiting approval**. Diagnosis, evidence, then the approval card.*

> "It says: code-level. Commit `a80e0f0`. Confidence 93%."

*Point at the evidence rows, one at a time.*

> "Four pieces of evidence, each with the tool that produced it. The pool is
> 10/10 with 34 waiters. A deploy 12 minutes ago. 187 timeout errors tagged with
> that exact release."

> "It proposes **one** action — roll back to the previous deploy — and it has not
> run. The runtime stopped it."

### 2:00 — The human gate (30s)

*Point at the approval card. Say nothing for a beat.*

> "This is the part I want you to remember. This is a production rollback, and
> the agent cannot do it. It has to wait for a person."

**Click "Approve & run".**

> "Now it runs, and then it has to prove it worked. It doesn't get to declare
> victory."

### 2:30 — The verification (30s)

*Status goes Executing → Resolved. The chart's marker shows where approval happened.*

> "Error rate before: 42%. After: 0.2%. The vertical line is the approval.
> Everything to the right of it is recovery, measured — not asserted. The agent
> watched a 60-second window before it was allowed to say 'resolved'."

### 3:00 — The honest case (30s)

> "One more thing, because it's the reason this isn't a toy. If it had restarted
> the service instead of rolling back, the metrics would have looked great for
> about a minute — and the leak would have come straight back. That's **mitigated**,
> not resolved. The system is built to tell you the difference, and Scenario B is
  the same idea from the other side: an infra problem where rolling back would
> be *wrong*, because there's no bad deploy to roll back to."

### 3:30 — Safety, in one breath (20s)

> "Three things. Only whitelisted actions exist as tools — there is no arbitrary
> command for the model to reach. Every write tool is gated by the runtime, not
> by our code. And the model never holds a credential; they live in the MCP
> servers."

### 3:50 — Close (10s)

> "PEAK. Detect, investigate, diagnose, propose, approve, verify. The human stays
> in the loop, and the recovery is measured."

---

## Playbook

### If the agent proposes the wrong fix

**Do not correct it.** That is the interesting failure.

> "It's wrong — restarting only masks a connection leak. Which is exactly the
> point: the approval gate is where a human catches it. Watch what happens when
> I reject it."

Reject, then re-run cleanly for the resolved ending.

### If a tool call is slow

> "It's calling the real APIs. This is the actual round trip."

Keep talking over the chart. Never narrate a spinner.

### If something is broken

1. Say what you're doing: *"Let me reset and re-run — one sec."*
2. `POST /api/demo/reset`, re-trigger, continue from **0:35**.
3. If it's not back in 45s, **switch to the backup video** and keep talking.

### Never do these on stage

- Restart a service to fix a stuck metric. If the demo app is wedged, reset it
  *before* you start.
- Open a terminal and read an error out loud.
- Claim a metric is improving when you have not watched it for 30s.
- Say "resolved" for something the dashboard shows as mitigated.
