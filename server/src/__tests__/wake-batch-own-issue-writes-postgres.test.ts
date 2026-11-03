import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake_batch write tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Route-level proof for OPT-533: a `wake_batch` run has no single `issueId`,
 * only `paperclipBatchedWakes[]`. It must be able to comment on and close each
 * issue of its batch without spending the cross-issue budget, and stay refused
 * on any issue outside the batch.
 */
describeEmbeddedPostgres("wake_batch run writes on its batch issues (routes + postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-batch-writes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    const cleanups = [
      () => db.delete(issueComments),
      () => db.delete(activityLog),
      () => db.delete(agentWakeupRequests),
      () => db.delete(heartbeatRuns),
      () => db.delete(issues),
      () => db.delete(companyMemberships),
      () => db.delete(agents),
      () => db.delete(companies),
    ];
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const prefix = "WB";
    await db.insert(companies).values({
      id: companyId,
      name: "Wake Batch Company",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Batch Detector",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "wb-operator",
      status: "active",
      membershipRole: "operator",
    });

    // The batch mixes an idle `todo` issue and an `in_progress` one whose
    // checkout is not held by any run, the two shapes a batched wake lands on.
    const seedIssue = async (n: number, status: "todo" | "in_progress") => {
      const id = randomUUID();
      await db.insert(issues).values({
        id,
        companyId,
        identifier: `${prefix}-${n}`,
        title: `${prefix} issue ${n}`,
        status,
        priority: "medium",
        assigneeAgentId: agentId,
      });
      return { id, identifier: `${prefix}-${n}` };
    };
    const batchA = await seedIssue(1, "todo");
    const batchB = await seedIssue(2, "in_progress");
    const outside = await seedIssue(3, "todo");

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      // Same shape as `deliverBatch` in services/heartbeat.ts. The second entry
      // carries a lower-cased identifier to prove the match ignores case.
      contextSnapshot: {
        wakeReason: "wake_batch",
        paperclipBatchedWakes: [
          { issueId: batchA.id, identifier: batchA.identifier, reason: "issue_commented" },
          { issueId: batchB.id, identifier: batchB.identifier.toLowerCase(), reason: "issue_commented" },
        ],
      },
    });
    const actor = { type: "agent", source: "agent_key", companyId, agentId, runId };
    return { companyId, agentId, runId, actor, batchA, batchB, outside };
  }

  async function countInfluenceRows(companyId: string, runId: string) {
    const rows = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    return rows.filter((row) => row.action.startsWith("issue.cross_issue_influence_")).length;
  }

  it("comments on and closes each batch issue, and is refused outside the batch", async () => {
    const { companyId, runId, actor, batchA, batchB, outside } = await seed();
    const client = request(app(actor));

    for (const issue of [batchA, batchB]) {
      const comment = await client
        .post(`/api/issues/${issue.id}/comments`)
        .send({ body: `Batch result for ${issue.identifier}` });
      expect(comment.status, JSON.stringify(comment.body)).toBe(201);

      const done = await client
        .patch(`/api/issues/${issue.id}`)
        .send({ status: "done", comment: `Closing ${issue.identifier}` });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body.status).toBe("done");
    }

    const closed = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(Object.fromEntries(closed.map((row) => [row.id, row.status]))).toMatchObject({
      [batchA.id]: "done",
      [batchB.id]: "done",
      [outside.id]: "todo",
    });
    // Batch writes are the run's own writes: nothing charged to the cap.
    expect(await countInfluenceRows(companyId, runId)).toBe(0);

    const outsideComment = await client
      .post(`/api/issues/${outside.id}/comments`)
      .send({ body: "Not my batch" });
    expect(outsideComment.status).toBe(403);
    expect(outsideComment.body.details?.code).toBe("cross_issue_influence_run_context_required");

    const outsideDone = await client
      .patch(`/api/issues/${outside.id}`)
      .send({ status: "done" });
    expect(outsideDone.status).toBe(403);
    expect(outsideDone.body.details?.code).toBe("cross_issue_influence_run_context_required");

    const outsideComments = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, outside.id));
    expect(outsideComments).toHaveLength(0);
    const [outsideRow] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, outside.id));
    expect(outsideRow?.status).toBe("todo");
  });
});
