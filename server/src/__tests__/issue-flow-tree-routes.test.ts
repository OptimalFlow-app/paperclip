import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueExecutionDecisions,
  issueRelations,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import type { IssueFlowTreeResponse } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { buildIssueFlowTree } from "../services/issue-flow-tree.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres flow tree route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

function boardActor(company: CompanyRow): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [company.id],
    memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

async function seedCompany(db: Db) {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: `Flow Tree ${nonce}`,
    issuePrefix: `FT${nonce.slice(0, 4).toUpperCase()}`,
  }).returning();
  return company!;
}

async function seedAgent(db: Db, companyId: string, name: string) {
  const [agent] = await db.insert(agents).values({
    companyId,
    name,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  }).returning();
  return agent!;
}

async function seedIssue(
  db: Db,
  input: {
    companyId: string;
    title: string;
    status?: string;
    parentId?: string | null;
    assigneeAgentId?: string | null;
    executionPolicy?: Record<string, unknown> | null;
    executionState?: Record<string, unknown> | null;
    createdAt?: Date;
  },
) {
  const [issue] = await db.insert(issues).values({
    companyId: input.companyId,
    parentId: input.parentId ?? null,
    title: input.title,
    status: input.status ?? "todo",
    priority: "medium",
    assigneeAgentId: input.assigneeAgentId ?? null,
    executionPolicy: input.executionPolicy ?? null,
    executionState: input.executionState ?? null,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  }).returning();
  return issue!;
}

describeEmbeddedPostgres("issue flow tree route", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-flow-tree-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueRelations);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns nested sub-tasks with blockers, review rounds and contributors", async () => {
    const company = await seedCompany(db);
    const author = await seedAgent(db, company.id, "Author");
    const reviewer = await seedAgent(db, company.id, "Reviewer");
    const stageId = randomUUID();
    const root = await seedIssue(db, { companyId: company.id, title: "Mission", status: "in_progress" });
    const stage1 = await seedIssue(db, {
      companyId: company.id,
      parentId: root.id,
      title: "Stage 1",
      status: "done",
      assigneeAgentId: reviewer.id,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        maxReviewRounds: 4,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: reviewer.id }],
        }],
      },
      executionState: {
        status: "completed",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: { type: "agent", agentId: author.id, userId: null },
        reviewRequest: null,
        completedStageIds: [stageId],
        lastDecisionId: null,
        lastDecisionOutcome: "approved",
        changesRequestedCount: 0,
      },
    });
    const stage2 = await seedIssue(db, {
      companyId: company.id,
      parentId: root.id,
      title: "Stage 2",
      status: "blocked",
      createdAt: new Date("2025-12-01T00:00:00Z"),
    });
    const grandchild = await seedIssue(db, { companyId: company.id, parentId: stage2.id, title: "Stage 2a" });
    await db.insert(issueRelations).values({
      companyId: company.id,
      issueId: stage1.id,
      relatedIssueId: stage2.id,
      type: "blocks",
    });
    await db.insert(issueExecutionDecisions).values([
      {
        companyId: company.id,
        issueId: stage1.id,
        stageId,
        stageType: "review",
        actorAgentId: reviewer.id,
        outcome: "changes_requested",
        body: "**Fix**   the\n`sources`",
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
      {
        companyId: company.id,
        issueId: stage1.id,
        stageId,
        stageType: "review",
        actorAgentId: reviewer.id,
        outcome: "changes_requested",
        body: "Still missing one source",
        createdAt: new Date("2026-01-03T00:00:00Z"),
      },
      {
        companyId: company.id,
        issueId: stage1.id,
        stageId,
        stageType: "review",
        actorAgentId: reviewer.id,
        outcome: "approved",
        body: "Approved",
        createdAt: new Date("2026-01-04T00:00:00Z"),
      },
    ]);

    const res = await request(createApp(db, boardActor(company))).get(`/api/issues/${root.id}/flow-tree`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as IssueFlowTreeResponse;
    expect(body.rootIssueId).toBe(root.id);
    expect(body.truncated).toBe(false);
    expect(body.nodes.map((node) => [node.title, node.depth])).toEqual([
      ["Mission", 0],
      ["Stage 2", 1],
      ["Stage 1", 1],
      ["Stage 2a", 2],
    ]);

    const s1 = body.nodes.find((node) => node.id === stage1.id)!;
    expect(s1.stages).toHaveLength(1);
    expect(s1.stages[0]).toMatchObject({ id: stageId, type: "review", status: "completed", roundsUsed: 2, maxRounds: 4 });
    expect(s1.stages[0]!.decisions.map((decision) => decision.outcome)).toEqual([
      "changes_requested",
      "changes_requested",
      "approved",
    ]);
    expect(s1.stages[0]!.decisions[0]!.bodyExcerpt).toBe("Fix the sources");
    expect(s1.contributors).toEqual([
      { type: "agent", agentId: author.id, userId: null, role: "author" },
      { type: "agent", agentId: reviewer.id, userId: null, role: "reviewer" },
    ]);

    const s2 = body.nodes.find((node) => node.id === stage2.id)!;
    expect(s2.blockedBy).toEqual([{ id: stage1.id, identifier: stage1.identifier }]);
    expect(s2.stages).toEqual([]);
    expect(body.nodes.find((node) => node.id === grandchild.id)!.parentId).toBe(stage2.id);
  });

  it("defaults the round maximum to 3 and hides the tree from other companies", async () => {
    const company = await seedCompany(db);
    const other = await seedCompany(db);
    const reviewer = await seedAgent(db, company.id, "Reviewer");
    const stageId = randomUUID();
    const root = await seedIssue(db, {
      companyId: company.id,
      title: "Single stage",
      status: "in_review",
      assigneeAgentId: reviewer.id,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "approval",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: reviewer.id }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "approval",
        currentParticipant: { type: "agent", agentId: reviewer.id, userId: null },
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        changesRequestedCount: 0,
      },
    });

    const [pending] = await db.insert(issueThreadInteractions).values({
      companyId: company.id,
      issueId: root.id,
      kind: "request_confirmation",
      status: "pending",
      payload: { version: 1, prompt: "Ship it?" } as never,
    }).returning();
    await db.insert(issueThreadInteractions).values({
      companyId: company.id,
      issueId: root.id,
      kind: "request_confirmation",
      status: "accepted",
      addresseeAgentId: reviewer.id,
      payload: { version: 1, prompt: "Already answered" } as never,
    });

    const res = await request(createApp(db, boardActor(company))).get(`/api/issues/${root.id}/flow-tree`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const node = (res.body as IssueFlowTreeResponse).nodes[0]!;
    expect(node.pendingConfirmations).toEqual([{ id: pending!.id, kind: "request_confirmation", addressee: null }]);
    expect(node.stages[0]).toMatchObject({ status: "active", roundsUsed: 0, maxRounds: 3 });
    expect(node.executionState?.currentParticipant).toEqual({ type: "agent", agentId: reviewer.id, userId: null });

    const otherAgent = await seedAgent(db, other.id, "Outsider");
    const [otherRun] = await db.insert(heartbeatRuns).values({
      companyId: other.id,
      agentId: otherAgent.id,
      status: "running",
      contextSnapshot: {},
    }).returning();
    const denied = await request(createApp(db, {
      type: "agent",
      agentId: otherAgent.id,
      companyId: other.id,
      runId: otherRun!.id,
      source: "agent_jwt",
    } as Express.Request["actor"])).get(`/api/issues/${root.id}/flow-tree`);
    // Uniform 404 so cross-tenant ids are indistinguishable from missing ones.
    expect(denied.status, JSON.stringify(denied.body)).toBe(404);
  });
});

describe("buildIssueFlowTree", () => {
  it("drops branches whose parent is not visible", () => {
    const base = {
      companyId: "c",
      projectId: null,
      identifier: null,
      status: "todo",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      completedAt: null,
      assigneeAgentId: null,
      assigneeUserId: null,
      executionPolicy: null,
      executionState: null,
    };
    const tree = buildIssueFlowTree({
      rootIssueId: "root",
      rows: [
        { ...base, id: "root", parentId: "outside", title: "Root", depth: 0 },
        { ...base, id: "visible", parentId: "root", title: "Visible", depth: 1 },
        { ...base, id: "orphan", parentId: "hidden", title: "Orphan", depth: 2 },
      ],
      relations: [{ issueId: "hidden", relatedIssueId: "visible" }],
      decisions: [],
      truncated: false,
    });
    expect(tree.nodes.map((node) => node.id)).toEqual(["root", "visible"]);
    expect(tree.nodes[0]!.parentId).toBeNull();
    expect(tree.nodes[1]!.blockedBy).toEqual([]);
  });
});
