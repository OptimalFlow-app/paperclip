# CLI and Secrets

Moved verbatim from `SKILL.md` so the core skill stays small. Paths such as `references/x.md` are relative to the skill root.

## Authentication details and local CLI

Env vars auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`. Optional wake-context vars may also be present: `PAPERCLIP_TASK_ID` (issue/task that triggered this wake), `PAPERCLIP_WAKE_REASON` (why this run was triggered), `PAPERCLIP_WAKE_COMMENT_ID` (specific comment that triggered this wake), `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, and `PAPERCLIP_LINKED_ISSUE_IDS` (comma-separated). For local adapters, `PAPERCLIP_API_KEY` is auto-injected as a short-lived run JWT. For sandbox-backed local adapters, the Bash/tool environment may receive `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY` for a run-scoped bridge instead of the host API directly; use those exact env vars from Bash/curl and do not assume the host port is reachable from browser or web tools. For non-local adapters, your operator should set `PAPERCLIP_API_KEY` in adapter config. All requests use `Authorization: Bearer $PAPERCLIP_API_KEY`. All endpoints are under `/api`. Use JSON except for multipart attachment uploads and binary content downloads. Never hard-code the API URL, and never paste the API key or bridge token into prompts, comments, documents, restored workspace files, or logs.

Manual local CLI mode (outside heartbeat runs): use `paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` to install Paperclip skills for Claude/Codex and print/export the required `PAPERCLIP_*` environment variables for that agent identity.

**CLI safety — use `npx paperclipai` for content-bearing arguments.** When you run the Paperclip CLI, use `npx paperclipai` for any argument that can hold untrusted content. Untrusted content includes issue text, comment bodies, Markdown, pasted snippets, and model output. `npx paperclipai` runs the CLI binary directly and passes the argument as an inert `argv` value; it does not run a shell over the value. Do not use `pnpm paperclipai` for such an argument. `pnpm paperclipai` is a `package.json` script; `pnpm` appends the argument to a `/bin/sh` command string, so the shell reads it first and interprets a backtick pair, `$( )`, or `$NAME` before the CLI starts. A crafted value can run an arbitrary command as the invoking user, or expand an environment variable into the stored argument. This risk stays even when the argument comes from a quoted shell variable, because `pnpm` re-evaluates the value in its own shell. Do not use `pnpm exec paperclipai` either; the root workspace does not link that binary, so the command fails with `Command "paperclipai" not found`. To run local `cli/src` changes with a content-bearing argument, use `node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts <command> <args>`. See `doc/CLI.md` for the full safe/unsafe matrix.

## Proposing Credentials Safely

**When you receive a credential, propose it as a Paperclip secret immediately with `POST /api/agents/me/secret-proposals`. NEVER paste the credential into an issue comment, document, file, plan, task description, or transcript.** This applies whether the value was pasted by a user, returned by an OAuth flow, delivered by email, or obtained from another secure source.

Before proposing a credential you MUST read the "Agent secret proposals" section in:
`skills/paperclip/references/api-reference.md`

## Reading Granted Secrets

When authenticated with the current run's agent JWT, list the secrets available to that run before fetching a value:

```bash
PAPERCLIP_API_BASE="${PAPERCLIP_API_URL%/}"
PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/agents/me/secrets"
```

The list is metadata-only. Fetch a specific value only when needed; the request has no body:

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/agents/me/secrets/github_token/value"
```

- An `env.*` secret binding also grants API read access; `access.*` bindings grant API access without env injection.
- Prefer env injection for values needed on every run by the adapter or its child processes.
- Prefer on-demand fetch for values used only on some runs, large or structured values, or skills/tools that do not inherit adapter env.
- Every value fetch, including failures, is audited in `secret_access_events` and `activity_log`; never print, persist, or paste fetched values into task comments.
- These endpoints require the current run-bound agent JWT. Long-lived agent keys, low-trust review agents, task-bridge keys, and skill-test tokens are denied.

Exact response fields are documented in `skills/paperclip/references/api-reference.md`.
