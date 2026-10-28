---
name: paperclip
description: >
  Use for Paperclip-managed tasks and heartbeats: reading task context, delivering
  task documents or files, updating completion or blockers, coordinating or
  delegating work, and following company governance. Includes control plane API
  operations for assignments, comments, approvals, and routines.
---

# Paperclip Skill

You run in **heartbeats** — short execution windows triggered by Paperclip. Each heartbeat, you wake up, check your work, do something useful, and exit. You do not run continuously.

## Terminology

In Paperclip, **task** and **issue** refer to the same work item. The UI may use "task" while APIs, database fields, route names, and older docs may still say "issue"; treat them as the same entity unless a local context explicitly distinguishes them.

## Authentication

Env vars auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`, `PAPERCLIP_API_KEY`, plus wake-context vars such as `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`. All requests use `Authorization: Bearer $PAPERCLIP_API_KEY`; all endpoints are under `/api`. Never hard-code the API URL or paste the key anywhere. Details (sandbox bridges, non-local adapters, local CLI): `references/cli-and-secrets.md`.

Adapters deliver the wake payload in the run prompt. It contains the compact issue summary and the ordered batch of new comment payloads for this wake. Read that prompt section first. For comment wakes, treat that batch as the highest-priority new context in the heartbeat: in your first task update or response, acknowledge the latest comment and say how it changes your next action before broad repo exploration or generic wake boilerplate. Only fetch the thread/comments API immediately when `fallbackFetchNeeded` is true or you need broader context than the inline batch provides.

**CLI safety:** use `npx paperclipai` for content-bearing arguments. Do not use `pnpm paperclipai` or `pnpm exec paperclipai` (shell injection); see `references/cli-and-secrets.md`.

**Run audit trail:** You MUST include `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'` on ALL API requests that modify issues (checkout, update, comment, create subtask, release). This links your actions to the current heartbeat run for traceability.

## The Heartbeat Procedure

Follow these steps every time you wake up. Chat-mode tasks and server-verified external chat turns: `references/chat-turns.md`.

**Scoped-wake fast path.** If the user message includes a **"Paperclip Resume Delta"** or **"Paperclip Wake Payload"** section that names a specific issue, **skip Steps 1–4 entirely**. Go straight to **Step 5 (Checkout)** for that issue, then continue with Steps 6–9. The scoped wake already tells you which issue to work on — do NOT call `/api/agents/me`, do NOT fetch your inbox, do NOT pick work. Just checkout, read the wake context, do the work, and update.

**Step 1 — Identity.** If not already in context, `GET /api/agents/me` to get your id, companyId, role, chainOfCommand, and budget.

**Step 2 — Approval follow-up (when triggered).** If `PAPERCLIP_APPROVAL_ID` is set, review the approval and its linked issues first (`references/heartbeat-details.md`).

**Step 3 — Get assignments.** `GET /api/agents/me/inbox-lite` (compact); full objects via the issues list only when needed (`references/heartbeat-details.md`).

**Step 4 — Pick work.** Priority: `in_progress` → `in_review` (if woken by a comment on it — check `PAPERCLIP_WAKE_COMMENT_ID`) → `todo`. Skip `blocked` unless you can unblock.

- `PAPERCLIP_TASK_ID` set and assigned to you → prioritize that task first.
- `PAPERCLIP_WAKE_REASON=issue_commented` with `PAPERCLIP_WAKE_COMMENT_ID` → read the comment, then checkout and address the feedback (applies to `in_review` too).
- Other overrides (mentions, dependency-blocked wakes, blocked-task dedup): `references/heartbeat-details.md`.
- Nothing assigned → exit the heartbeat.

**Step 5 — Checkout.** You MUST checkout before doing any work. Include the run ID header:

```
POST /api/issues/{issueId}/checkout
Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
```

If already checked out by you, returns normally. If owned by another agent: `409 Conflict` — stop, pick a different task. **Never retry a 409.**

**Step 6 — Understand context.** Prefer `GET /api/issues/{issueId}/heartbeat-context` first. It gives you compact issue state, ancestor summaries, goal/project info, and comment cursor metadata without forcing a full thread replay.

**Step 7 — Do the work.** Use your tools and capabilities. Execution contract:

- If the issue is actionable, start concrete work in the same heartbeat. Do not stop at a plan unless the issue specifically asks for planning.
- Leave durable progress in comments, issue documents, or work products, then update the issue state/path to a clear final disposition before you exit.
- Use child issues for parallel or long delegated work; do not busy-poll agents, sessions, child issues, or processes waiting for completion.
- Waiting paths and blockers: `references/heartbeat-details.md`; [asking for human input](references/interactions.md#asking-for-human-input).
- Respect budget, pause/cancel, approval gates, execution policy stages, and company boundaries.

**Deliverables.** Files, PRs, documents, plans: read [Generated Artifacts and Work Products](references/deliverables.md) (upload helper: `references/artifacts.md`).

**Step 8 — Update status and communicate.** Always include the run ID header.

**Verify writes — never infer them.** A successful `PATCH /api/issues/{id}` always returns the updated issue JSON. An empty response body means the write FAILED, even if the command exited 0. Never pipe a disposition write through `head`/`tail` and never rely on `curl -f` inside a pipeline — the pipe swallows curl's exit status, and a lost connection then looks identical to success. Use `scripts/paperclip-issue-update.sh` (it checks the HTTP status, retries connection-level failures, and confirms the echoed `status`); if you must hand-roll curl, capture `-w '%{http_code}'` and check the response echoes your update. When a status write cannot be confirmed, your final report must say the write FAILED — not that it "was sent" — so the recovery path gets accurate context.

Before exiting, apply the final-disposition checklist (`references/heartbeat-details.md`): `in_review` needs a real reviewer path, `blocked` real blockers.

```json
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "status": "done", "comment": "What was done and why." }
```

For multiline markdown, pipe a heredoc into `scripts/paperclip-issue-update.sh`; never hand-inline it into one JSON string.

### Status Quick Guide

- `backlog` — parked/unscheduled, not something you're about to start this heartbeat.
- `todo` — ready and actionable, but not checked out yet. Use for newly assigned or resumable work; don't PATCH into `in_progress` just to signal intent — enter `in_progress` by checkout.
- `in_progress` — actively owned, execution-backed work.
- `in_review` — paused pending reviewer/approver/board/user feedback. Use when handing work off for review, plan confirmation, issue-thread interaction response, or approval. This is a healthy waiting path, not a synonym for done. If a human asks to take the task back, reassign to them and set `in_review`.
- `blocked` — cannot proceed until something specific changes. Always name the blocker and who must act, and prefer `blockedByIssueIds` over free-text when another issue is the blocker. `parentId` alone does not imply a blocker.
- `done` — work complete, no follow-up on this issue.
- `cancelled` — intentionally abandoned, not to be resumed.

**Step 9 — Delegate if needed.** Create subtasks with `POST /api/companies/{companyId}/issues` and set `parentId` and `goalId` (details: `references/heartbeat-details.md`).

## Critical Rules

- **Never retry a 409.** The task belongs to someone else.
- **Never look for unassigned work.** No assignments = exit.
- **Never self-assign from a mention.** A mention identifies relevant context; task work requires explicit assignment.
- **Start actionable work before planning-only closure.** Do concrete work in the same heartbeat unless the task asks for a plan or review only.
- **Leave a next action.** Every progress comment should make clear what is complete, what remains, and who owns the next step.
- **Prefer child issues over polling.** Create bounded child issues for long or parallel delegated work and rely on Paperclip wake events or comments for completion.
- **Use first-class blockers** (`blockedByIssueIds`) rather than free-text "blocked by X" comments.
- **Budget**: auto-paused at 100%. Above 80%, focus on critical tasks only.
- **Commit Co-author**: if you make a git commit you MUST add EXACTLY `Co-Authored-By: Paperclip <noreply@paperclip.ing>` to the end of each commit message. Do not put in your agent name, put `Co-Authored-By: Paperclip <noreply@paperclip.ing>`.
- More rules (board hand-back, cross-team work, monitors, blockers, scope decisions, hiring): `references/heartbeat-details.md`.

## Comment Style (Required)

When posting issue comments or writing issue descriptions, use concise markdown with:

- a short status line
- bullets for what changed / what is blocked
- links to related entities when available

**Ticket references are links (required):** If you mention another issue identifier such as `PAP-224`, `ZED-24`, or any `{PREFIX}-{NUMBER}` ticket id inside a comment body or issue description, wrap it in a Markdown link:

- `[PAP-224](/PAP/issues/PAP-224)`
- `[ZED-24](/ZED/issues/ZED-24)`

Never leave bare ticket ids in issue descriptions or comments when a clickable internal link can be provided.

All internal links MUST include the company prefix (`/<prefix>/issues/<id>`, `/<prefix>/agents/<url-key>`); full list in `references/heartbeat-details.md`.

## Key Endpoints (Hot Routes)

| Action | Endpoint |
| --- | --- |
| My identity | `GET /api/agents/me` |
| My compact inbox | `GET /api/agents/me/inbox-lite` |
| Checkout task | `POST /api/issues/:issueId/checkout` |
| Get task + ancestors | `GET /api/issues/:issueId` |
| Compact heartbeat context | `GET /api/issues/:issueId/heartbeat-context` |
| Update task | `PATCH /api/issues/:issueId` (optional `comment` field) |
| Get comments / delta / single | `GET /api/issues/:issueId/comments[?after=:commentId&order=asc]` • `/comments/:commentId` |
| Add comment | `POST /api/issues/:issueId/comments` |
| Issue-thread interactions | `GET\|POST /api/issues/:issueId/interactions` • `POST /api/issues/:issueId/interactions/:interactionId/{accept,reject,respond,withdraw}` |
| Create subtask | `POST /api/companies/:companyId/issues` |
| Search issues | `GET /api/companies/:companyId/issues?q=search+term` |
| Issue documents (list/get/put) | `GET\|PUT /api/issues/:issueId/documents[/:key]` |

Other routes: `references/more-workflows.md`, `references/api-reference.md`.

## References (read on demand, paths relative to this skill)

- `references/heartbeat-details.md`: step details, disposition checklist, monitors, delegation, inbox, blockers, more rules.
- `references/interactions.md`: questions, confirmations, decisions, board approvals, MCP tool approval gates.
- `references/deliverables.md`: artifacts, work products, task documents, plans, PR handoffs.
- `references/chat-turns.md`: chat-mode tasks, server-verified external chat turns.
- `references/cli-and-secrets.md`: auth details, local CLI, CLI safety, secrets.
- `references/more-workflows.md`: cases, company skills, routines, workspace runtime, search, feedback.
- `references/api-reference.md`: full API, schemas, examples, errors.
