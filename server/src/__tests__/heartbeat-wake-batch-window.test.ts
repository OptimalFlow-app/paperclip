import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

// Each adapter execution blocks until the test releases it, so a run stays
// "running" exactly as long as the test needs an agent to look busy.
const adapterGate = vi.hoisted(() => {
  const releases = new Map<string, () => void>();
  const started: Array<{ runId: string; context: Record<string, unknown> }> = [];
  return {
    releases,
    started,
    autoRelease: false,
    release(runId: string) {
      const release = releases.get(runId);
      if (!release) throw new Error(`run ${runId} has not started`);
      releases.delete(runId);
      release();
    },
    releaseAll() {
      for (const runId of [...releases.keys()]) this.release(runId);
    },
    reset() {
      releases.clear();
      started.length = 0;
      this.autoRelease = false;
    },
  };
});

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (ctx: { runId: string; context: Record<string, unknown> }) => {
    adapterGate.started.push({ runId: ctx.runId, context: ctx.context });
    if (!adapterGate.autoRelease) {
      await new Promise<void>((resolve) => adapterGate.releases.set(ctx.runId, resolve));
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Wake batch window test run.",
      provider: "test",
      model: "test-model",
    };
  }),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake batch window tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat wake batch window", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const services: Array<ReturnType<typeof heartbeatService>> = [];

  function newHeartbeat() {
    const { PAPERCLIP_MAX_CONCURRENT_RUNS: _ignored, ...baseEnv } = process.env;
    const heartbeat = heartbeatService(db, { runtimeEnv: baseEnv });
    services.push(heartbeat);
    return heartbeat;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-wake-batch-window-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    adapterGate.autoRelease = true;
    adapterGate.releaseAll();
    for (const heartbeat of services) await heartbeat.drainActiveRunExecutions();
    services.length = 0;
    adapterGate.reset();
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await db.execute(sql`truncate table ${companies} cascade`);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setup(batchWindowSec?: number) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const prefix = `B${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Batch Co",
      status: "active",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "board-user",
    });
    const heartbeatConfig: Record<string, unknown> = {
      enabled: false,
      wakeOnDemand: true,
      maxConcurrentRuns: 1,
    };
    if (batchWindowSec !== undefined) heartbeatConfig.batchWindowSec = batchWindowSec;
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Batched Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: { heartbeat: heartbeatConfig },
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
        permissions: {},
      },
    ]);
    let issueNumber = 0;
    const createIssue = async (overrides: Partial<typeof issues.$inferInsert> = {}) => {
      issueNumber += 1;
      const [issue] = await db
        .insert(issues)
        .values({
          companyId,
          title: `Batched issue ${issueNumber}`,
          status: "todo",
          priority: "medium",
          assigneeAgentId: agentId,
          issueNumber,
          identifier: `${prefix}-${issueNumber}`,
          ...overrides,
        })
        .returning();
      return issue!;
    };
    return { companyId, agentId, otherAgentId, createIssue };
  }

  function agentWake(
    agentId: string,
    actorAgentId: string,
    issueId: string,
    reason: string,
    extra: { contextSnapshot?: Record<string, unknown>; payload?: Record<string, unknown>; idempotencyKey?: string } = {},
  ) {
    return {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason,
      payload: { issueId, ...(extra.payload ?? {}) },
      contextSnapshot: { issueId, wakeReason: reason, ...(extra.contextSnapshot ?? {}) },
      requestedByActorType: "agent" as const,
      requestedByActorId: actorAgentId,
      idempotencyKey: extra.idempotencyKey ?? null,
    };
  }

  async function wakeRows(agentId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(asc(agentWakeupRequests.requestedAt));
  }

  async function runsFor(agentId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)).orderBy(asc(heartbeatRuns.createdAt));
  }

  /** Back-dates the agent's batched wakes so they look admitted `minutesAgo[i]` minutes ago. */
  async function ageBatchedWakes(agentId: string, minutesAgo: number[]) {
    const rows = (await wakeRows(agentId)).filter((row) => row.status === "batched");
    expect(rows).toHaveLength(minutesAgo.length);
    for (const [index, row] of rows.entries()) {
      await db
        .update(agentWakeupRequests)
        .set({ requestedAt: new Date(Date.now() - minutesAgo[index]! * 60_000) })
        .where(eq(agentWakeupRequests.id, row.id));
    }
  }

  async function waitForStarted(count: number) {
    await vi.waitFor(() => expect(adapterGate.started.length).toBeGreaterThanOrEqual(count), {
      timeout: 15_000,
      interval: 20,
    });
  }

  it("delivers three issues assigned at 0, 2 and 4 minutes in a single run (window 300 s)", async () => {
    const heartbeat = newHeartbeat();
    const { agentId, otherAgentId, createIssue } = await setup(300);
    const issueA = await createIssue();
    const issueB = await createIssue();
    const issueC = await createIssue();

    for (const issue of [issueA, issueB, issueC]) {
      expect(await heartbeat.wakeup(agentId, agentWake(agentId, otherAgentId, issue.id, "issue_assigned"))).toBeNull();
    }
    expect((await wakeRows(agentId)).map((row) => row.status)).toEqual(["batched", "batched", "batched"]);
    expect(await runsFor(agentId)).toHaveLength(0);

    // At minute 4 the oldest wake is 4 minutes old: the window is still open.
    await ageBatchedWakes(agentId, [4, 2, 0]);
    expect(await heartbeat.flushDueWakeBatches()).toMatchObject([{ agentId, outcome: "waiting" }]);
    expect(await runsFor(agentId)).toHaveLength(0);

    // At minute 5 the window has elapsed.
    await ageBatchedWakes(agentId, [5, 3, 1]);
    const [result] = await heartbeat.flushDueWakeBatches();
    expect(result).toMatchObject({ agentId, outcome: "batch" });

    const runs = await runsFor(agentId);
    expect(runs).toHaveLength(1);
    const context = runs[0]!.contextSnapshot as Record<string, unknown>;
    expect(context.issueId).toBeUndefined();
    expect(context.wakeReason).toBe("wake_batch");
    const batched = context.paperclipBatchedWakes as Array<Record<string, unknown>>;
    expect(batched.map((entry) => entry.issueId)).toEqual([issueA.id, issueB.id, issueC.id]);
    expect(batched.map((entry) => entry.identifier)).toEqual([issueA.identifier, issueB.identifier, issueC.identifier]);

    const rows = await wakeRows(agentId);
    const batchRows = rows.filter((row) => row.reason === "issue_assigned");
    expect(batchRows.map((row) => [row.status, row.runId])).toEqual([
      ["coalesced", runs[0]!.id],
      ["coalesced", runs[0]!.id],
      ["coalesced", runs[0]!.id],
    ]);

    // The adapter receives a prompt that lists the three issues.
    await waitForStarted(1);
    const prompt = renderPaperclipWakePrompt(adapterGate.started[0]!.context.paperclipWake);
    expect(prompt).toContain("## Paperclip Batched Wakes");
    for (const issue of [issueA, issueB, issueC]) {
      expect(prompt).toContain(`### ${issue.identifier} ${issue.title}`);
    }
    expect(prompt).toContain("POST /api/issues/{issueId}/checkout");
  });

  it("loses no wake: a review stage, a lifted blocker and an answered interaction all reach the run", async () => {
    const heartbeat = newHeartbeat();
    const { companyId, agentId, otherAgentId, createIssue } = await setup(300);
    const reviewIssue = await createIssue({ status: "in_review" });
    const unblockedIssue = await createIssue();
    const interactionIssue = await createIssue({ status: "in_progress" });
    const [comment] = await db
      .insert(issueComments)
      .values({ companyId, issueId: interactionIssue.id, authorAgentId: otherAgentId, body: "Here is the answer you asked for." })
      .returning();
    const interactionId = randomUUID();

    await heartbeat.wakeup(agentId, agentWake(agentId, otherAgentId, reviewIssue.id, "execution_review_requested"));
    await heartbeat.wakeup(agentId, {
      ...agentWake(agentId, otherAgentId, unblockedIssue.id, "issue_blockers_resolved"),
      requestedByActorType: "system",
      requestedByActorId: null,
    });
    await heartbeat.wakeup(agentId, agentWake(agentId, otherAgentId, interactionIssue.id, "issue_commented", {
      // An answered interaction wakes its issue with the verified
      // `mutation: "interaction"` payload; that keeps its continuation context.
      payload: {
        commentId: comment!.id,
        mutation: "interaction",
        interactionId,
        interactionKind: "ask_user_questions",
        interactionStatus: "answered",
      },
      contextSnapshot: {
        commentId: comment!.id,
        wakeCommentId: comment!.id,
        interactionId,
        interactionKind: "ask_user_questions",
        interactionStatus: "answered",
      },
      idempotencyKey: `interaction:${interactionId}`,
    }));
    expect((await wakeRows(agentId)).map((row) => row.status)).toEqual(["batched", "batched", "batched"]);

    await ageBatchedWakes(agentId, [5, 5, 5]);
    expect(await heartbeat.flushDueWakeBatches()).toMatchObject([{ outcome: "batch" }]);

    const runs = await runsFor(agentId);
    expect(runs).toHaveLength(1);
    const batched = (runs[0]!.contextSnapshot as Record<string, unknown>).paperclipBatchedWakes as Array<Record<string, unknown>>;
    expect(batched.map((entry) => [entry.issueId, entry.reason])).toEqual([
      [reviewIssue.id, "execution_review_requested"],
      [unblockedIssue.id, "issue_blockers_resolved"],
      [interactionIssue.id, "issue_commented"],
    ]);
    expect(batched[2]).toMatchObject({ interactionId, wakeCommentIds: [comment!.id] });

    await waitForStarted(1);
    const prompt = renderPaperclipWakePrompt(adapterGate.started[0]!.context.paperclipWake);
    expect(prompt).toContain(`answered interaction: ${interactionId}`);
    expect(prompt).toContain("Here is the answer you asked for.");
  });

  it("cancels wakes whose issue closed or changed hands during the window, and starts no run for an empty batch", async () => {
    const heartbeat = newHeartbeat();
    const { agentId, otherAgentId, createIssue } = await setup(300);
    const closedIssue = await createIssue();
    const reassignedIssue = await createIssue();

    await heartbeat.wakeup(agentId, agentWake(agentId, otherAgentId, closedIssue.id, "issue_assigned"));
    await heartbeat.wakeup(agentId, agentWake(agentId, otherAgentId, reassignedIssue.id, "issue_assigned"));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, closedIssue.id));
    await db.update(issues).set({ assigneeAgentId: otherAgentId }).where(eq(issues.id, reassignedIssue.id));

    await ageBatchedWakes(agentId, [6, 6]);
    expect(await heartbeat.flushDueWakeBatches()).toMatchObject([{ agentId, outcome: "empty" }]);
    expect(await runsFor(agentId)).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect((await wakeRows(agentId)).map((row) => [row.status, row.error])).toEqual([
      ["cancelled", "batch_issue_closed"],
      ["cancelled", "batch_reassigned"],
    ]);
  });

  it("delivers a batch of one as the ordinary issue-bound run", async () => {
    const heartbeat = newHeartbeat();
    const { agentId, otherAgentId, createIssue } = await setup(300);
    const issue = await createIssue();

    await heartbeat.wakeup(agentId, agentWake(agentId, otherAgentId, issue.id, "issue_assigned"));
    await ageBatchedWakes(agentId, [5]);
    expect(await heartbeat.flushDueWakeBatches()).toMatchObject([{ outcome: "single" }]);

    const runs = await runsFor(agentId);
    expect(runs).toHaveLength(1);
    expect((runs[0]!.contextSnapshot as Record<string, unknown>).issueId).toBe(issue.id);
    expect((runs[0]!.contextSnapshot as Record<string, unknown>).paperclipBatchedWakes).toBeUndefined();
    const rows = await wakeRows(agentId);
    expect(rows.find((row) => row.status === "coalesced")?.runId).toBe(runs[0]!.id);
  });

  it("lets a user wake and a wake on a critical issue start at once", async () => {
    const heartbeat = newHeartbeat();
    const { agentId, otherAgentId, createIssue } = await setup(300);
    const userIssue = await createIssue();
    const criticalIssue = await createIssue({ priority: "critical" });

    const userRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_assigned",
      payload: { issueId: userIssue.id },
      contextSnapshot: { issueId: userIssue.id, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
    expect(userRun).not.toBeNull();
    const criticalRun = await heartbeat.wakeup(agentId, agentWake(agentId, otherAgentId, criticalIssue.id, "issue_assigned"));
    expect(criticalRun).not.toBeNull();

    const statuses = (await wakeRows(agentId)).map((row) => row.status);
    expect(statuses).not.toContain("batched");
    const runs = await runsFor(agentId);
    expect(runs.map((run) => (run.contextSnapshot as Record<string, unknown>).issueId).sort())
      .toEqual([userIssue.id, criticalIssue.id].sort());
  });

  it("holds wakes on other issues while a run is active and delivers them together once it ends", async () => {
    const heartbeat = newHeartbeat();
    const { agentId, otherAgentId, createIssue } = await setup(300);
    const busyIssue = await createIssue({ priority: "critical" });
    const issueB = await createIssue();
    const issueC = await createIssue();

    const busyRun = await heartbeat.wakeup(agentId, agentWake(agentId, otherAgentId, busyIssue.id, "issue_assigned"));
    await waitForStarted(1);

    await heartbeat.wakeup(agentId, agentWake(agentId, otherAgentId, issueB.id, "issue_assigned"));
    await heartbeat.wakeup(agentId, agentWake(agentId, otherAgentId, issueC.id, "issue_assigned"));
    await ageBatchedWakes(agentId, [6, 6]);

    expect(await heartbeat.flushDueWakeBatches()).toMatchObject([{ agentId, outcome: "waiting" }]);
    expect(await runsFor(agentId)).toHaveLength(1);

    // The busy run finishes. Its end flushes the batch when the agent is idle;
    // any follow-up the server queues first makes the next scheduler tick
    // (resumeQueuedRuns) flush it instead. Either way: one run, after the end.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, busyIssue.id));
    adapterGate.release(busyRun!.id);
    await vi.waitFor(async () => {
      const batchRun = (await runsFor(agentId)).find((run) =>
        Array.isArray((run.contextSnapshot as Record<string, unknown>).paperclipBatchedWakes));
      if (!batchRun) await heartbeat.resumeQueuedRuns();
      expect(batchRun).toBeDefined();
    }, { timeout: 15_000, interval: 250 });
    const runs = await runsFor(agentId);
    const batchRuns = runs.filter((run) =>
      Array.isArray((run.contextSnapshot as Record<string, unknown>).paperclipBatchedWakes));
    expect(batchRuns).toHaveLength(1);
    const busy = runs.find((run) => run.id === busyRun!.id)!;
    expect(batchRuns[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(busy.finishedAt!.getTime());
    const batched = (batchRuns[0]!.contextSnapshot as Record<string, unknown>).paperclipBatchedWakes as Array<Record<string, unknown>>;
    expect(batched.map((entry) => entry.issueId)).toEqual([issueB.id, issueC.id]);
  });

  it.each([
    ["absent", undefined],
    ["0", 0],
  ])("keeps today's behaviour when the window is %s", async (_label, window) => {
    const heartbeat = newHeartbeat();
    const { agentId, otherAgentId, createIssue } = await setup(window);
    const issueA = await createIssue();
    const issueB = await createIssue();

    expect(await heartbeat.wakeup(agentId, agentWake(agentId, otherAgentId, issueA.id, "issue_assigned"))).not.toBeNull();
    expect(await heartbeat.wakeup(agentId, agentWake(agentId, otherAgentId, issueB.id, "issue_assigned"))).not.toBeNull();
    const statuses = (await wakeRows(agentId)).map((row) => row.status);
    expect(statuses).not.toContain("batched");
    expect(await runsFor(agentId)).toHaveLength(2);
    expect(await heartbeat.flushDueWakeBatches()).toEqual([]);
  });

  it("merges a second plain wake on an issue already in the batch", async () => {
    const heartbeat = newHeartbeat();
    const { companyId, agentId, otherAgentId, createIssue } = await setup(300);
    const issue = await createIssue();
    const [comment] = await db
      .insert(issueComments)
      .values({ companyId, issueId: issue.id, authorAgentId: otherAgentId, body: "One more thing." })
      .returning();

    await heartbeat.wakeup(agentId, agentWake(agentId, otherAgentId, issue.id, "issue_assigned"));
    await heartbeat.wakeup(agentId, agentWake(agentId, otherAgentId, issue.id, "issue_commented", {
      payload: { commentId: comment!.id },
      contextSnapshot: { commentId: comment!.id, wakeCommentId: comment!.id },
    }));
    const rows = (await wakeRows(agentId)).filter((row) => row.status === "batched");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.coalescedCount).toBe(1);
    const context = (rows[0]!.payload as Record<string, unknown>)._paperclipWakeContext as Record<string, unknown>;
    expect(context.wakeCommentIds).toEqual([comment!.id]);
    expect(((rows[0]!.payload as Record<string, unknown>).wakeBatch as Record<string, unknown>).reasons)
      .toEqual(["issue_assigned", "issue_commented"]);
  });
});
