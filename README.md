# PEAK: AI incident response

**Connect → Monitor → Detect → Investigate → Ask approval → Fix → Verify**

PEAK watches your production services. When one breaks, an AI agent reads the Sentry errors and recent GitHub commits, finds the commit that caused it, and posts the root cause to Slack. After a human clicks **Approve**, it reverts that commit and confirms the service recovered.

```
 Health URL ─┐                        ┌──────────── TrueForge ────────────┐
 Sentry ─────┼─▶ Monitor ─▶ Incident ─▶│ agent loop · approval gate · model │
             │   (every 10s)           │ fallback (TrueFoundry/Groq/…) │
             │                         └───────────────┬───────────────────┘
             │                                         │ MCP (/mcp, bearer)
             │                ┌────────────────────────▼───────────────────┐
             │                │ PEAK tools: get_incident · list_errors ·    │
             │                │ get_error_details · list_recent_commits ·   │
             │                │ get_commit_diff · get_file ·                │
             │                │ check_service_health · submit_diagnosis ·   │
             │                │ revert_commit · apply_patch (approval)      │
             │                └─────────────────────────────────────────────┘
             ▼
 Dashboard (React) ◀── SSE ── PEAK server (Express + Postgres) ──▶ Slack
```

## The incident loop

1. **Detect.** Every `MONITOR_INTERVAL_SEC` PEAK calls each service's health URL and counts its Sentry events from the last minute. An incident opens when errors reach `ERROR_THRESHOLD_PER_MIN`, or after `FAILED_CHECKS_TO_ALERT` failed health checks in a row. Slack gets "🚨 investigating".
2. **Investigate.** A TrueForge session runs the runbook in [`server/src/agent/instructions.md`](server/src/agent/instructions.md): read the errors and stack traces, list the commits, read the diffs, and tie the error to one commit. Each tool call shows up live on the incident timeline.
3. **Diagnose.** The agent calls `submit_diagnosis` with the root cause, confidence, cited evidence and the proposed fix. The dashboard and Slack show it.
4. **Approve.** The agent calls `revert_commit`, and TrueForge pauses the turn until someone decides. A human clicks **Approve** or **Reject** on the dashboard, or in Slack if interactivity is set up. `revert_commit` also refuses to run unless PEAK recorded the approval and the SHA matches the diagnosis.
5. **Fix.** Two kinds, both behind the same approval gate:
   - **Revert** (preferred when one recent commit caused it): PEAK adds a revert commit on top of the branch; history is not rewritten. It refuses if a later commit touched the same files.
   - **Code fix** (when no single commit is to blame, or the culprit also holds changes that must stay): the agent proposes exact find/replace edits. PEAK validates them against the branch and shows the diff for approval: at most 3 files and 60 changed lines, existing files only, never CI, dependency manifests, lockfiles, secrets or infrastructure. On approval `apply_patch` applies exactly that stored diff, either as a **pull request** (default; PEAK waits for the merge, then verifies against the merge commit) or as a **direct commit**. Choose on the Connections page under *Code fixes*.

   Your CD pipeline deploys the fix.
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

Open http://localhost:5173 and create an account (email + password, or GitHub). Accounts,
sessions, connections and incidents are stored in Postgres at `DATABASE_URL` (e.g. Neon), in a
`peak` schema. Leave it empty for a local PGlite database under `data/pglite`.

Every user connects **their own** accounts under **Connections**. Nothing is shared from `.env`:

| Source | How |
|---|---|
| GitHub | **Connect with GitHub**: authorize in the browser, then pick a repository you can push to and its deployed branch. OAuth only — there is no token field. Needs a GitHub OAuth App (below). |
| Slack | **Connect with Slack**: install the PEAK app on your Slack workspace, then pick the channel from the list. PEAK joins the channel itself. Needs a Slack app (below). |
| Sentry | Organization slug and a **user** auth token (`sntryu_…`) with `project:read`, `event:read`, `org:read`. Organization tokens (`sntrys_…`) can't read events. EU region: `https://de.sentry.io`. The one source still pasted by hand, because Sentry has no install-a-bot flow. |

Then add each **service**: a name, its health URL and/or its Sentry project, and optionally a latency threshold. If the health endpoint returns JSON like `{"status":"ok","release":"<git sha>"}`, PEAK can confirm the fix actually deployed.

**GitHub OAuth App** (github.com → Settings → Developer settings → OAuth Apps): callback URL `<APP_URL>/api/auth/github/callback`, then set `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`. The same app powers "Sign in with GitHub" (profile + email only) and "Connect with GitHub" (asks for `repo` so PEAK can revert commits; the token is stored encrypted per workspace).

**Slack app** (api.slack.com/apps → Create New App → From a manifest): paste the manifest below, create it, then set the app's **Redirect URL** to `<APP_URL>/api/auth/slack/callback` and set `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`. Install it on your workspace from the app's page. PEAK never sees a pasted bot token — Slack mints one for the installation and hands it over in the callback, and PEAK stores it encrypted per workspace.

```yaml
display_information:
  name: PEAK
  description: Posts incident diagnosis and proposed fixes to your channel
features:
  bot_user:
    display_name: PEAK
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - channels:read
      - groups:read
      - channels:join
      - groups:join
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Add `channels:history` to the scopes if you want PEAK to read replies in the incident thread. Override the whole list with `SLACK_SCOPES` in `.env`.

Production: `npm run build && npm start` serves the dashboard from the server on `PORT`. Set `APP_URL` and `SERVER_URL`, and run TrueForge next to it.

### Optional

- **Approve from Slack:** set `SLACK_SIGNING_SECRET` and the Slack app's Interactivity Request URL to `<public APP_URL>/api/slack/interactions`. Anyone in the channel can then approve.

## Layout

```
server/src/
  index.js              Express app, MCP endpoint, static dashboard
  monitor.js            health + error-rate polling, incident detection
  verify.js             post-fix deploy check and watch window
  notify.js             Slack messages (one per incident, updated)
  auth.js               email/password + GitHub OAuth, cookie sessions
  store.js, db.js       Postgres (DATABASE_URL, tables in the `peak` schema); PGlite when unset
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

`GET /api/health` is a liveness probe; `GET /api/ready` returns 503 unless the database is writable and TrueForge + a model are reachable. Auth endpoints are rate limited (30 requests / 15 min per IP, 10 logins / 15 min per email, 10 sign-ups / hour per IP). Behind a reverse proxy set `TRUST_PROXY=1` so the per-IP limits see the real client address; without a proxy leave it 0, or clients could spoof `X-Forwarded-For`.
