# PEAK dashboard

P4 — one page: incident feed, diagnosis, the approval gate, and live metrics.

Consumes [`contracts/backend-api.md`](../contracts/backend-api.md).

## Run it

```bash
cd dashboard
npm install
npm run dev       # http://localhost:5173
```

The backend must be running on `:4000`. Vite proxies `/api` to it, so the
browser stays on one origin and there is no CORS to configure.

```bash
npm run build     # -> dist/
npm run preview   # serve the build on :5173
```

**Rehearse against `npm run preview`, not `npm run dev`.** A dev server that
dies mid-demo is a demo over. The build is 53KB gzipped with no runtime
dependencies, so there is no reason to take that risk.

## What's on screen, and why in that order

The detail column is arranged as an argument, top to bottom:

1. **Status** — what is happening right now
2. **Proposed action + Approve/Reject** — the human gate
3. **Diagnosis** — root cause, category, confidence
4. **Evidence** — each claim beside the tool that produced it
5. **Metrics** — before/after with the approval moment marked
6. **Event trail** — the raw runtime log, collapsed

A judge should be able to read it top to bottom without the layout raising a
question the answer isn't already on screen for.

## Decisions worth knowing

**No chart library.** The chart is ~150 lines of SVG arithmetic. Recharts is
~200KB plus a version matrix plus a build plugin, in exchange for a line and a
vertical rule. Bad trade two hours before a demo. The vertical marker at the
approval moment is the point of the panel: everything to its right is recovery.

**Poll at 2s, and pause when the tab is hidden.** `contracts/backend-api.md`
specifies polling over SSE — simpler, and 2s is invisible to a human. The pause
matters because a rehearsal involves a lot of alt-tabbing.

**Confidence is a bar, not a number.** `0.82` reads as false precision. The exact
value is in the tooltip.

**`mitigated` is amber, never green.** The whole argument of Scenario A is that
restarting a leaking service *hides* the problem. Showing mitigated in the same
green as resolved would be an own goal, so the mapping lives in exactly one
place — `components/StatusBadge.jsx`.

**Approve/Reject never fails silently.** The button disables while in flight and
re-enables with the error inline. A dead button on stage is the worst failure
mode in this project.

**Synthetic data is labelled.** If P1's demo app isn't reachable, the live strip
shows a `simulated data` pill and stale metrics show `stale`. We never let
generated numbers pass as real.

## Layout

```
src/
  App.jsx                 shell, selection, operator actions
  api/client.js           the only place that talks to the backend
  hooks/
    usePolledResource.js  polling: visibility pause, abort, keep-last-good
    useDomain.js          health, incidents, incident, metrics, decisions
  components/
    StatusBadge.jsx       status -> colour/label, in one place
    IncidentFeed.jsx      left column + scenario buttons
    IncidentDetail.jsx    right column
    Diagnosis.jsx         root cause + evidence list
    PendingActionCard.jsx the approval gate
    MetricsChart.jsx      hand-rolled SVG before/after
    LiveStrip.jsx         live service vitals
  styles.css              one file, CSS variables, dark, large type
```

## Empty and edge states, on purpose

- No incidents → tells you to trigger one.
- Selected incident resolved → full report, chart, and the operator's decision.
- Selected incident still wrapping up after a reject → says so, rather than
  freezing on "rejected" with no explanation.
- Backend down → a banner naming the port, not a blank page.
