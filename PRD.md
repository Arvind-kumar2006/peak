# PRD: PEAK V1, the incident loop

**Updated:** 2026-09-26

## Goal

Show the whole incident loop on one real incident:

> A developer pushes a bad commit → production starts throwing errors → PEAK detects it → checks logs and GitHub → finds the bad commit → explains the root cause → sends a Slack alert → a developer clicks **Approve fix** → PEAK reverts the commit → PEAK verifies that errors dropped to zero.

PEAK is not a Datadog, Sentry or AWS replacement. It connects to tools the team already uses.

## V1 scope

| Component | V1 |
|---|---|
| Auth | Email/password; GitHub OAuth (optional) |
| GitHub | ✅ commits, diffs, file reads, revert |
| Logs | **Sentry only** |
| Slack | ✅ alert, approval request, resolution (bot token or webhook) |
| Health checks | ✅ HTTP health URL per service |
| Database / Kubernetes / AWS / multi-cloud | ❌ |
| Fixes | **Revert one commit only**, and always after human approval |

## Features

1. **Connect & monitor:** sign up, connect GitHub, Sentry and Slack, then add services (health URL and/or Sentry project). The dashboard shows each service's health, an errors/min sparkline, and recent incidents.
2. **AI incident investigation:** an incident opens on an error spike or failing health checks. The agent reads the errors and stack traces, recent commits and diffs. It names the root cause and the likely culprit commit, with cited evidence and a confidence score.
3. **Fix, approval & verification:** the agent proposes a revert. It runs only after a human approves (on the dashboard or in Slack). PEAK then waits for the revert to deploy, watches health and errors, and reports Resolved or Not recovered with before/after numbers and the incident duration.

## Safety

- The only write action is `revert_commit`. It adds a new commit and never rewrites history. It refuses if later commits touched the same files.
- Two gates: TrueForge pauses the tool for approval, and PEAK refuses to run it unless the approval is recorded and the SHA matches the diagnosis.
- Tokens are encrypted at rest (AES-256-GCM). The model never sees credentials.
- After a rejected, failed or unrecovered incident, PEAK does not reopen one for that service for 15 minutes; a human owns it.

## Next (not V1)

CloudWatch as a second log source · Sentry/PagerDuty alert webhooks instead of polling · fix-forward PRs instead of reverts · redeploy/rollback through the hosting provider · multiple members per workspace.
