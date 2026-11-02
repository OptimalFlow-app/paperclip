# Deliverables, Documents, and Plans

Moved verbatim from `SKILL.md` so the core skill stays small. Paths such as `references/x.md` are relative to the skill root.

## Task documents (terminology note)

**Task documents (API runtimes).** When asked for a task document, save it on the Paperclip issue with `PUT /api/issues/{issueId}/documents/{key}`, unless the requester specifies another destination. Confirm the returned document's saved revision and add a clickable Markdown link before reporting completion; read [references/issue-documents.md](references/issue-documents.md) for the payload and revision-safe updates. Downloadable files follow [Generated Artifacts and Work Products](#generated-artifacts-and-work-products).

### Generated Artifacts and Work Products

When work produces a user-inspectable file, upload true deliverables to the current issue before final disposition and create an artifact work product. Local filesystem paths are not enough because board users, reviewers, and cloud operators may not have access to the agent workspace.

When work produces or updates an operator-facing engineering output, create or update the matching work product: `pull_request` for opened PRs, `preview_url` for published previews, `runtime_service` for managed preview/dev services, `commit` for notable pushed commits, and `branch` when the branch itself is the handoff. Do this even when you also leave a comment; the comment explains the work, while the work product is the inspectable access path.

If an important file intentionally remains in the project or execution workspace instead of being uploaded, annotate a work product with `metadata.resourceRef.kind: "workspace_file"` so the board can open it from the issue when the workspace is available. Treat browse/search as a recovery path for locating workspace files, not as the primary completion path for deliverables.

For technical upload instructions, read `references/artifacts.md`, except for
the routine server-verified external-chat handoff described above.

## Task Documents and Deliverables

Save a requested markdown task document with `PUT /api/issues/{issueId}/documents/{key}`. Use PUT for both creation and updates; POST is not supported here. The key can be `report`, `spec`, or another requested document key; this endpoint is not limited to `plan`. Include the usual bearer authorization and `X-Paperclip-Run-Id` headers.

For a new report, use:

```json
{"title":"Report","format":"markdown","body":"The completed report text","baseRevisionId":null}
```

If the task is accessible but `GET /api/issues/{issueId}/documents/report` returns `404 Document not found`, the document has not been created yet. Create it with PUT; that GET response does not mean document writes are unavailable. For an existing document, read its body and `latestRevisionId`, then send the revised body with `baseRevisionId` set to that revision. On `409`, fetch and reconcile the latest document before retrying.

Read the saved document back before marking the task done. A comment or local file does not satisfy a request for a task document. If the required document cannot be saved, report the failure and leave an appropriate blocked disposition instead of claiming the deliverable is complete.

## Planning (Required when planning requested)

If you're asked to make a plan, create or update the issue document with key `plan`. Do not append plans into the issue description anymore. If you're asked for plan revisions, update that same `plan` document. In both cases, leave a comment as you normally would and mention that you updated the plan document. Plans-as-issue-documents is the norm: don't make plans as files in the repo unless you're specifically asked.

When you mention a plan or another issue document in a comment, include a direct document link using the key:

- Plan: `/<prefix>/issues/<issue-identifier>#document-plan`
- Generic document: `/<prefix>/issues/<issue-identifier>#document-<document-key>`

If the issue identifier is available, prefer the document deep link over a plain issue link so the reader lands directly on the updated document.

If you're asked to make a plan, _do not mark the issue as done_. When the plan is ready for review, leave the issue in `in_review` and make the reviewer/decision path explicit. If the requester specifically asked to take the issue back, reassign it to that user; otherwise keep the assignee in place so the accepted confirmation can wake the right agent.

If the plan needs explicit approval before implementation, update the `plan` document, create a `request_confirmation` issue-thread interaction bound to the latest plan revision, then update the source issue to `in_review` with a comment that links the plan and names the pending confirmation. This is a deliberate waiting path, not an abandoned productive run. Wait for acceptance before creating implementation subtasks. See `references/api-reference.md` for the interaction payload.

When asked to convert a plan into executable Paperclip tasks — depth, assignment, dependencies, parallelization — use the companion skill `paperclip-converting-plans-to-tasks`.

Recommended API flow:

```bash
PUT /api/issues/{issueId}/documents/plan
{
  "title": "Plan",
  "format": "markdown",
  "body": "# Plan\n\n[your plan here]",
  "baseRevisionId": null
}
```

If `plan` already exists, first `GET /api/issues/{issueId}/documents/plan` and read its current body and `latestRevisionId`. Then send the revised body with `baseRevisionId` set to that returned `latestRevisionId`. The GET field is `latestRevisionId`; the PUT field is `baseRevisionId`. Omitting it on an update returns `409`. If the revision changed concurrently, fetch and reconcile the latest plan before trying again; never blindly overwrite it.

## External review handoffs

**External review handoffs.**

For a PR, put its link in the work product's top-level `url` field. If a human
must review or merge it before you can continue, name that action in a durable
human-only interaction with an appropriate continuation policy and leave the
task `in_review`. A `needs_board_review` work-product flag and a periodic monitor
do not create an interaction card. Keep any merge check bounded, record its
purpose in the monitor's `notes`, and verify the actual provider state when you
resume; a confirmation response is not proof of a merge. Update the existing PR
work product when the PR merges or closes instead of registering a duplicate.

The same rule applies to external release approval gates: link the exact run,
create a human-only confirmation asking whether the user approved it in the
provider, and keep the agent assigned with `continuationPolicy: "wake_assignee"`
so the answer resumes verification. A handoff comment asking the user to comment
back or reassign the task is not a confirmation card. The card records the user's
answer; verify the provider's gate and publish result before continuing.
