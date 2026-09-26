# PEAK: AI incident response

**Connect → Monitor → Detect → Investigate → Ask approval → Fix → Verify**

PEAK watches your production services. When one breaks, an AI agent reads the Sentry errors and recent GitHub commits, finds the commit that caused it, and posts the root cause to Slack. After a human clicks **Approve**, it reverts that commit and confirms the service recovered.

```
 Health URL ─┐                        ┌──────────── TrueForge ────────────┐
 Sentry ─────┼─▶ Monitor ─▶ Incident ─▶│ agent loop · approval gate · model │
             │   (every 10s)           │ fallback (TrueFoundry/Groq/…) │
             │                         └───────────────┬───────────────────┘
             │                                         │ MCP (/mcp/<token>)
             │                ┌────────────────────────▼───────────────────┐
             │                │ PEAK tools: get_incident · list_errors ·    │
             │                │ get_error_details · list_recent_commits ·   │
             │                │ get_commit_diff · get_file ·                │
             │                │ check_service_health · submit_diagnosis ·   │
             │                │ revert_commit (approval required)           │
             │                └─────────────────────────────────────────────┘
             ▼
 Dashboard (React) ◀── SSE ── PEAK server (Express + SQLite) ──▶ Slack
```

## The incident loop

1. **Detect.** Every `MONITOR_INTERVAL_SEC` PEAK calls each service's health URL and counts its Sentry events from the last minute. An incident opens when errors reach `ERROR_THRESHOLD_PER_MIN`, or after `FAILED_CHECKS_TO_ALERT` failed health checks in a row. Slack gets "🚨 investigating".
2. **Investigate.** A TrueForge session runs the runbook in [`server/src/agent/instructions.md`](server/src/agent/instructions.md): read the errors and stack traces, list the commits, read the diffs, and tie the error to one commit. Each tool call shows up live on the incident timeline.
3. **Diagnose.** The agent calls `submit_diagnosis` with the root cause, confidence, cited evidence and the proposed fix. The dashboard and Slack show it.
4. **Approve.** The agent calls `revert_commit`, and TrueForge pauses the turn until someone decides. A human clicks **Approve** or **Reject** on the dashboard, or in Slack if interactivity is set up. `revert_commit` also refuses to run unless PEAK recorded the approval and the SHA matches the diagnosis.
5. **Fix.** PEAK adds a revert commit on top of the branch through the GitHub API; history is not rewritten. It refuses if a later commit touched the same files. Your CD pipeline deploys the revert.
6. **Verify.** If the health endpoint reports a `release`/`commit`/`sha`, PEAK waits until the revert is live. Then it watches health and errors for `VERIFY_WINDOW_SEC`. The result is **Resolved** or **Not recovered**, with before/after errors/min. The Slack message is updated.

**Humans can always override.** Any incident can be **marked resolved** by hand, with a note ("fixed it myself", false alarm); this also stops the agent. Failed or handed-off incidents can be **re-run**. A service can be **muted** for 30m/1h/4h during deploys or maintenance: checks keep running, but no incident opens. Each service can also have a **latency threshold**, so slow responses alert before the service goes down.

If no commit explains the errors, the agent proposes nothing and the incident goes to **Needs a human**. Rejected, unresolved and failed incidents stop PEAK from reopening one for that service for 15 minutes.

## Run it

Requires Node ≥ 22.14.

```bash
npm install
cp .env.example .env        # add at least one model key (TRUEFOUNDRY_API_KEY, GROQ_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY or XAI_API_KEY)
npm run dev                 # TrueForge :8790 + Groq proxy :7310 + server :4000 + dashboard :5173
```

Open http://localhost:5173, create an account, then under **Connections**:

| Source | What to enter |
|---|---|
| GitHub | `owner/repo`, the deployed branch (default branch if empty), and a fine-grained PAT for that repo with **Contents: read & write**, **Metadata: read** |
| Sentry | Organization slug and a user auth token with `project:read`, `event:read`, `org:read`. Sentry URL for self-hosted or EU (`https://de.sentry.io`) |
| Slack | Bot token (`chat:write`, bot invited to the channel) plus channel, **or** an incoming webhook URL |

Then add each **service**: a name, its health URL and/or its Sentry project. If the health endpoint returns JSON like `{"status":"ok","release":"<git sha>"}`, PEAK can confirm the fix actually deployed.

Production: `npm run build && npm start` serves the dashboard from the server on `PORT`. Set `APP_URL` and `SERVER_URL`, and run TrueForge next to it.

### Optional

- **Sign in with GitHub:** create an OAuth App with callback `<APP_URL>/api/auth/github/callback`, then set `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.
- **Approve from Slack:** set `SLACK_SIGNING_SECRET` and the Slack app's Interactivity Request URL to `<public APP_URL>/api/slack/interactions`. Anyone in the channel can then approve.

## Layout

```
server/src/
  index.js              Express app, MCP endpoint, static dashboard
  monitor.js            health + error-rate polling, incident detection
  verify.js             post-fix deploy check and watch window
  notify.js             Slack messages (one per incident, updated)
  auth.js               email/password + GitHub OAuth, cookie sessions
  store.js, db.js       SQLite (node:sqlite) in data/peak.db
  integrations/         GitHub (incl. revert via Git Data API), Sentry, Slack
  agent/
    instructions.md     the runbook the model follows
    tools.js            MCP tools the agent calls
    runner.js           TrueForge sessions, approval pause/resume, restart recovery
    trueforge.js        TrueForge API client with provider fallback
    providers.js        TrueFoundry gateway → Groq → Gemini → OpenAI → xAI
server/model/groq-proxy.js   needed for Groq (TrueForge 0.2.1 sends fields Groq rejects)
web/src/                React dashboard: login, connections, services, incidents
```

`npm test` runs the server tests: both approval gates, `revertCommit` against a fake GitHub, detection/mute/cooldown, auth, rate limits and crypto. CI (`.github/workflows/ci.yml`) runs them and the web build on every push.

`GET /api/health` is a liveness probe; `GET /api/ready` returns 503 unless the database is writable and TrueForge + a model are reachable. Auth endpoints are rate limited (30 requests / 15 min per IP, 10 logins / 15 min per email, 10 sign-ups / hour per IP).
