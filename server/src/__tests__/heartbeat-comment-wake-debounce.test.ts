import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import {
  COMMENT_DEBOUNCE_STATUS,
  heartbeatService,
  parseCommentDebouncePolicy,
} from "../services/heartbeat.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres comment wake debounce tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("parseCommentDebouncePolicy", () => {
  it("defaults to a 120 s window capped at 300 s", () => {
    expect(parseCommentDebouncePolicy({})).toEqual({
      commentDebounceSec: 120,
      commentDebounceMaxSec: 300,
    });
  });

  it("treats 0 as disabled and never caps below the debounce delay", () => {
    expect(parseCommentDebouncePolicy({ commentDebounceSec: 0 }).commentDebounceSec).toBe(0);
    expect(
      parseCommentDebouncePolicy({ commentDebounceSec: 400, commentDebounceMaxSec: 60 }),
    ).toEqual({ commentDebounceSec: 400, commentDebounceMaxSec: 400 });
  });
});

describeEmbeddedPostgres("heartbeat comment wake debounce", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-comment-debounce-");
    db = createDb(started.connectionString);
    tempDb = started;
  }, 120_000);

  afterAll(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  }, 120_000);

  afterEach(() => {
    runningProcesses.clear();
  });

  async function seed(heartbeatConfig: Record<string, unknown>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Developer",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: heartbeatConfig },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Debounce comment wakes",
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { companyId, agentId, issueId };
  }

  async function addComment(companyId: string, issueId: string, body: string) {
    const [comment] = await db
      .insert(issueComments)
      .values({ companyId, issueId, authorUserId: "founder", body })
      .returning();
    return comment!;
  }

  // Same shape as the POST /issues/:id/comments assignee wake.
  function commentWake(issueId: string, commentId: string) {
    return {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: "issue_commented",
      payload: { issueId, commentId, mutation: "comment" },
      requestedByActorType: "user" as const,
      requestedByActorId: "founder",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId,
        wakeCommentId: commentId,
        source: "issue.comment",
        wakeReason: "issue_commented",
      },
    };
  }

  function listRuns(agentId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
  }

  function listDebounced(agentId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.status, COMMENT_DEBOUNCE_STATUS),
      ));
  }

  it("folds three close comments into one persisted wake and one run after the window", async () => {
    const { companyId, agentId, issueId } = await seed({ commentDebounceSec: 120, commentDebounceMaxSec: 300 });
    const heartbeat = heartbeatService(db);
    const startedAt = Date.now();

    const ids: string[] = [];
    for (const body of ["one", "two", "three"]) {
      const comment = await addComment(companyId, issueId, body);
      ids.push(comment.id);
      expect(await heartbeat.wakeup(agentId, commentWake(issueId, comment.id))).toBeNull();
    }

    expect(await listRuns(agentId)).toHaveLength(0);
    const held = await listDebounced(agentId);
    expect(held).toHaveLength(1);
    expect(held[0]!.coalescedCount).toBe(2);
    const debounce = (held[0]!.payload as Record<string, any>)._paperclipCommentDebounce;
    expect(debounce.commentIds).toEqual(ids);
    expect(Date.parse(debounce.dueAt)).toBeGreaterThanOrEqual(startedAt + 120_000);
    expect(Date.parse(debounce.dueAt)).toBeLessThanOrEqual(Date.parse(debounce.windowStartedAt) + 300_000);

    // Not due yet: a tick leaves it held.
    await heartbeat.tickTimers(new Date());
    expect(await listRuns(agentId)).toHaveLength(0);

    // A fresh service instance stands in for a restarted server: the held wake
    // is read back from the database, not from process memory.
    const restarted = heartbeatService(db);
    await restarted.tickTimers(new Date(Date.now() + 301_000));

    const runs = await listRuns(agentId);
    expect(runs).toHaveLength(1);
    expect((runs[0]!.contextSnapshot as Record<string, unknown>).wakeCommentIds).toEqual(ids);
    expect(await listDebounced(agentId)).toHaveLength(0);
    const [promoted] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, held[0]!.id));
    expect(promoted).toMatchObject({ status: "coalesced", runId: runs[0]!.id });
  }, 60_000);

  it("caps the sliding window from the first comment", async () => {
    const { companyId, agentId, issueId } = await seed({ commentDebounceSec: 120, commentDebounceMaxSec: 130 });
    const heartbeat = heartbeatService(db);
    for (const body of ["one", "two"]) {
      const comment = await addComment(companyId, issueId, body);
      await heartbeat.wakeup(agentId, commentWake(issueId, comment.id));
    }
    const [held] = await listDebounced(agentId);
    const debounce = (held!.payload as Record<string, any>)._paperclipCommentDebounce;
    expect(Date.parse(debounce.dueAt)).toBeLessThanOrEqual(Date.parse(debounce.windowStartedAt) + 130_000);
    await heartbeat.tickTimers(new Date(Date.now() + 131_000));
    expect(await listRuns(agentId)).toHaveLength(1);
  }, 60_000);

  it("drops deleted comments from the batch and cancels a batch with none left", async () => {
    const { companyId, agentId, issueId } = await seed({ commentDebounceSec: 120 });
    const heartbeat = heartbeatService(db);
    const comment = await addComment(companyId, issueId, "oops");
    await heartbeat.wakeup(agentId, commentWake(issueId, comment.id));
    const [held] = await listDebounced(agentId);
    await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, comment.id));

    await heartbeat.tickTimers(new Date(Date.now() + 301_000));

    expect(await listRuns(agentId)).toHaveLength(0);
    const [cancelled] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, held!.id));
    expect(cancelled!.status).toBe("cancelled");
  }, 60_000);

  it("keeps the immediate wake when commentDebounceSec is 0", async () => {
    const { companyId, agentId, issueId } = await seed({ commentDebounceSec: 0 });
    const heartbeat = heartbeatService(db);
    const comment = await addComment(companyId, issueId, "now");

    const run = await heartbeat.wakeup(agentId, commentWake(issueId, comment.id));

    expect(run).not.toBeNull();
    expect((run!.contextSnapshot as Record<string, unknown>).wakeCommentIds).toEqual([comment.id]);
    expect(await listDebounced(agentId)).toHaveLength(0);
  }, 60_000);

  it("sends an interaction answer immediately during an open window and flushes the held comments", async () => {
    const { companyId, agentId, issueId } = await seed({ commentDebounceSec: 120 });
    const heartbeat = heartbeatService(db);
    const comment = await addComment(companyId, issueId, "held");
    expect(await heartbeat.wakeup(agentId, commentWake(issueId, comment.id))).toBeNull();
    expect(await listDebounced(agentId)).toHaveLength(1);

    const interactionId = randomUUID();
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, interactionId, interactionKind: "ask_user_questions", interactionStatus: "answered", mutation: "interaction" },
      idempotencyKey: `interaction:${interactionId}:answered`,
      requestedByActorType: "user",
      requestedByActorId: "founder",
      contextSnapshot: { issueId, taskId: issueId, interactionId, wakeReason: "issue_commented", source: "issue.interaction" },
    });

    expect(run).not.toBeNull();
    expect(await listDebounced(agentId)).toHaveLength(0);
    const runs = await listRuns(agentId);
    expect(runs.map((row) => row.id)).toContain(run!.id);
  }, 60_000);

  it("sends an assignment immediately during an open window", async () => {
    const { companyId, agentId, issueId } = await seed({ commentDebounceSec: 120 });
    const heartbeat = heartbeatService(db);
    const comment = await addComment(companyId, issueId, "held");
    expect(await heartbeat.wakeup(agentId, commentWake(issueId, comment.id))).toBeNull();

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "update" },
      requestedByActorType: "user",
      requestedByActorId: "founder",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned", source: "issue.update" },
    });

    expect(run).not.toBeNull();
    expect(await listDebounced(agentId)).toHaveLength(0);
  }, 60_000);

  it("leaves the existing queue behaviour when the agent already runs on the issue", async () => {
    const { companyId, agentId, issueId } = await seed({ commentDebounceSec: 120 });
    const heartbeat = heartbeatService(db);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });
    runningProcesses.set(runId, { child: {} as never, graceSec: 0, processGroupId: null });
    await db
      .update(issues)
      .set({ status: "in_progress", executionRunId: runId, executionAgentNameKey: "developer", executionLockedAt: new Date() })
      .where(eq(issues.id, issueId));
    const comment = await addComment(companyId, issueId, "while running");

    expect(await heartbeat.wakeup(agentId, commentWake(issueId, comment.id))).toBeNull();

    expect(await listDebounced(agentId)).toHaveLength(0);
    const deferred = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
      ));
    expect(deferred).toHaveLength(1);
  }, 60_000);
});
