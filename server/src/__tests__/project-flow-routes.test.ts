import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueExecutionDecisions,
  issues,
  issueThreadInteractions,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelines,
  pipelineStages,
  projects,
} from "@paperclipai/db";
import type { ProjectFlowResponse } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { readStageFlowConfig, readStageIssueRefs, stepState } from "../services/project-flow.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project flow route tests on this host: ${
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
    name: `Project Flow ${nonce}`,
    issuePrefix: `PF${nonce.slice(0, 4).toUpperCase()}`,
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
  input: { companyId: string; identifier: string; title: string; status?: string; assigneeAgentId?: string | null },
) {
  const [issue] = await db.insert(issues).values({
    companyId: input.companyId,
    identifier: input.identifier,
    title: input.title,
    status: input.status ?? "todo",
    priority: "medium",
    assigneeAgentId: input.assigneeAgentId ?? null,
  }).returning();
  return issue!;
}

async function seedPipeline(
  db: Db,
  input: {
    companyId: string;
    projectId: string;
    key: string;
    stages: Array<{ key: string; kind: string; config?: Record<string, unknown> }>;
  },
) {
  const [pipeline] = await db.insert(pipelines).values({
    companyId: input.companyId,
    projectId: input.projectId,
    key: input.key,
    name: input.key,
  }).returning();
  const stages = await db.insert(pipelineStages).values(
    input.stages.map((stage, position) => ({
      pipelineId: pipeline!.id,
      key: stage.key,
      name: stage.key,
      kind: stage.kind,
      position,
      config: stage.config ?? {},
    })),
  ).returning();
  const stageByKey = new Map(stages.map((stage) => [stage.key, stage]));
  return { pipeline: pipeline!, stageByKey };
}

describeEmbeddedPostgres("project flow route", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-flow-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(pipelineCases);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(issueThreadInteractions);
    await db.delete(issueExecutionDecisions);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns every stage of each case, with stage tasks, review rounds and the origin task fallback", async () => {
    const company = await seedCompany(db);
    const author = await seedAgent(db, company.id, "Storyliner");
    const critic = await seedAgent(db, company.id, "Critic");
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Decks" }).returning();

    const deck = await seedPipeline(db, {
      companyId: company.id,
      projectId: project!.id,
      key: "deck",
      stages: [
        { key: "brief", kind: "working" },
        { key: "storyline", kind: "working", config: { flow: { author: { agentId: author.id }, verifier: { agentId: critic.id }, maxReviewRounds: 4 } } },
        { key: "build", kind: "working" },
        { key: "final-review", kind: "review", config: { flow: { verifier: "Alexis" } } },
        { key: "released", kind: "done" },
        { key: "dropped", kind: "cancelled" },
      ],
    });
    const mission = await seedIssue(db, { companyId: company.id, identifier: "PF-1", title: "Deck mission", status: "in_progress" });
    const storyline = await seedIssue(db, {
      companyId: company.id,
      identifier: "PF-2",
      title: "Storyline",
      status: "in_review",
      assigneeAgentId: author.id,
    });
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: critic.id, userId: null },
        returnAssignee: { type: "agent", agentId: author.id, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: "changes_requested",
        changesRequestedCount: 1,
      },
    }).where(eq(issues.id, storyline.id));
    await db.insert(issueExecutionDecisions).values({
      companyId: company.id,
      issueId: storyline.id,
      stageId: randomUUID(),
      stageType: "review",
      actorAgentId: critic.id,
      outcome: "changes_requested",
      body: "**Tighten**  slide 3",
    });
    const [deckCase] = await db.insert(pipelineCases).values({
      companyId: company.id,
      pipelineId: deck.pipeline.id,
      stageId: deck.stageByKey.get("storyline")!.id,
      caseKey: "deck-bpi",
      title: "Deck BPI",
      fields: { stageIssues: { storyline: "pf-2", build: "PF-404" } },
    }).returning();
    await db.insert(pipelineCaseIssueLinks).values({
      companyId: company.id,
      caseId: deckCase!.id,
      issueId: mission.id,
      role: "origin",
    });

    const com = await seedPipeline(db, {
      companyId: company.id,
      projectId: project!.id,
      key: "com",
      stages: [
        { key: "idea", kind: "working" },
        { key: "critique", kind: "review" },
        { key: "published", kind: "done" },
      ],
    });
    const content = await seedIssue(db, { companyId: company.id, identifier: "PF-3", title: "Post C2", status: "blocked" });
    const [comCase] = await db.insert(pipelineCases).values({
      companyId: company.id,
      pipelineId: com.pipeline.id,
      stageId: com.stageByKey.get("critique")!.id,
      caseKey: "c2",
      title: "C2",
    }).returning();
    await db.insert(pipelineCaseIssueLinks).values({ companyId: company.id, caseId: comCase!.id, issueId: content.id, role: "origin" });
    await db.insert(pipelineCases).values({
      companyId: company.id,
      pipelineId: com.pipeline.id,
      stageId: com.stageByKey.get("published")!.id,
      caseKey: "c1",
      title: "C1",
      terminalKind: "done",
    });

    // A pipeline of another project stays out of this flow.
    const [otherProject] = await db.insert(projects).values({ companyId: company.id, name: "Other" }).returning();
    await seedPipeline(db, { companyId: company.id, projectId: otherProject!.id, key: "other", stages: [{ key: "a", kind: "working" }] });

    const res = await request(createApp(db, boardActor(company))).get(`/api/projects/${project!.id}/flow`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as ProjectFlowResponse;
    expect(body.pipelines.map((pipeline) => pipeline.key)).toEqual(["deck", "com"]);

    const deckFlow = body.pipelines[0]!;
    expect(deckFlow.stages.map((stage) => stage.key)).toEqual(["brief", "storyline", "build", "final-review", "released"]);
    expect(deckFlow.stages[1]).toMatchObject({
      author: { agentId: author.id, userId: null, label: null },
      verifier: { agentId: critic.id, userId: null, label: null },
      maxReviewRounds: 4,
    });
    expect(deckFlow.stages[3]!.verifier).toEqual({ agentId: null, userId: null, label: "Alexis" });

    const deckRow = deckFlow.cases[0]!;
    expect(deckRow.originIssue).toEqual({ id: mission.id, identifier: "PF-1", title: "Deck mission" });
    expect(deckRow.steps.map((step) => step.state)).toEqual(["done", "waiting", "not_started", "not_started", "not_started"]);
    expect(deckRow.progress).toEqual({ done: 1, total: 5 });
    const storylineStep = deckRow.steps[1]!;
    expect(storylineStep.issueSource).toBe("stage");
    expect(storylineStep.issue).toMatchObject({
      id: storyline.id,
      identifier: "PF-2",
      hasReview: true,
      roundsUsed: 1,
      maxRounds: 4,
      waitingOn: [{ type: "agent", agentId: critic.id, userId: null }],
    });
    expect(storylineStep.issue!.decisions[0]!.bodyExcerpt).toBe("Tighten slide 3");
    expect(storylineStep.waitingOn).toEqual([{ type: "agent", agentId: critic.id, userId: null }]);
    // An unknown identifier leaves the stage without a task.
    expect(deckRow.steps[2]!.issue).toBeNull();

    const comFlow = body.pipelines[1]!;
    const [c2, c1] = comFlow.cases;
    expect(c2!.steps.map((step) => step.state)).toEqual(["done", "blocked", "not_started"]);
    expect(c2!.steps[1]).toMatchObject({ issueSource: "origin", issue: { id: content.id, hasReview: false, maxRounds: 3 } });
    expect(c1!.terminalKind).toBe("done");
    expect(c1!.steps.map((step) => step.state)).toEqual(["done", "done", "done"]);
  });

  it("keeps a finished stage task waiting on the main task's card until the case moves on", async () => {
    const company = await seedCompany(db);
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Decks" }).returning();
    const deck = await seedPipeline(db, {
      companyId: company.id,
      projectId: project!.id,
      key: "deck",
      stages: [{ key: "registry", kind: "working" }, { key: "storyline", kind: "working" }, { key: "build", kind: "working" }],
    });
    const mission = await seedIssue(db, { companyId: company.id, identifier: "PF-43", title: "Mission", status: "in_review" });
    await seedIssue(db, { companyId: company.id, identifier: "PF-48", title: "Storyline r2", status: "done" });
    await db.insert(issueThreadInteractions).values({
      companyId: company.id,
      issueId: mission.id,
      kind: "request_confirmation",
      status: "pending",
      payload: { version: 1, prompt: "Is this the right story?" },
    });
    const [deckCase] = await db.insert(pipelineCases).values({
      companyId: company.id,
      pipelineId: deck.pipeline.id,
      stageId: deck.stageByKey.get("storyline")!.id,
      caseKey: "deck-bpi",
      title: "Deck BPI",
      fields: { stageIssues: { storyline: "PF-48" } },
    }).returning();
    await db.insert(pipelineCaseIssueLinks).values({ companyId: company.id, caseId: deckCase!.id, issueId: mission.id, role: "origin" });

    const res = await request(createApp(db, boardActor(company))).get(`/api/projects/${project!.id}/flow`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = (res.body as ProjectFlowResponse).pipelines[0]!.cases[0]!;
    expect(row.steps.map((step) => step.state)).toEqual(["done", "waiting", "not_started"]);
    expect(row.steps[1]).toMatchObject({
      issueSource: "stage",
      issue: { identifier: "PF-48", status: "done" },
      waitingOn: [{ type: "user", agentId: null, userId: null }],
    });
  });

  it("hides the project flow from another company", async () => {
    const company = await seedCompany(db);
    const other = await seedCompany(db);
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Decks" }).returning();

    const outsider = await seedAgent(db, other.id, "Outsider");
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: other.id,
      agentId: outsider.id,
      status: "running",
      contextSnapshot: {},
    }).returning();

    const res = await request(createApp(db, {
      type: "agent",
      agentId: outsider.id,
      companyId: other.id,
      runId: run!.id,
      source: "agent_jwt",
    } as Express.Request["actor"])).get(`/api/projects/${project!.id}/flow`);

    // Uniform 404 so cross-tenant ids are indistinguishable from missing ones.
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });

  it("returns an empty flow for a project without pipelines", async () => {
    const company = await seedCompany(db);
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Empty" }).returning();

    const res = await request(createApp(db, boardActor(company))).get(`/api/projects/${project!.id}/flow`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ projectId: project!.id, pipelines: [] });
  });
});

describe("project flow helpers", () => {
  const issue = (status: string, waitingOn: number = 0) => ({
    id: "i",
    identifier: null,
    title: "t",
    status: status as never,
    assigneeAgentId: null,
    assigneeUserId: null,
    hasReview: false,
    roundsUsed: 0,
    maxRounds: 3,
    decisions: [],
    waitingOn: Array.from({ length: waitingOn }, () => ({ type: "user" as const, agentId: null, userId: null })),
  });

  it("derives the step state from the case position, then the stage task", () => {
    const base = { currentIndex: 2, stageKind: "working" as const, caseTerminalKind: null, issue: null };
    expect(stepState({ ...base, index: 0 })).toBe("done");
    expect(stepState({ ...base, index: 0, issue: issue("blocked") })).toBe("done");
    expect(stepState({ ...base, index: 2 })).toBe("active");
    expect(stepState({ ...base, index: 2, stageKind: "review" })).toBe("waiting");
    expect(stepState({ ...base, index: 2, issue: issue("todo", 1) })).toBe("waiting");
    expect(stepState({ ...base, index: 2, issue: issue("blocked") })).toBe("blocked");
    expect(stepState({ ...base, index: 3 })).toBe("not_started");
    expect(stepState({ ...base, index: 3, issue: issue("todo") })).toBe("not_started");
    expect(stepState({ ...base, index: 3, issue: issue("in_progress") })).toBe("active");
    expect(stepState({ ...base, index: 2, caseTerminalKind: "cancelled" })).toBe("cancelled");
    // A finished stage task on a case that has not moved yet still waits for validation.
    expect(stepState({ ...base, index: 2, issue: issue("done") })).toBe("waiting");
    expect(stepState({ ...base, index: 2, issue: issue("done"), originIssue: issue("blocked") })).toBe("blocked");
    expect(stepState({ ...base, index: 2, stageKind: "done" })).toBe("done");
    expect(stepState({ ...base, index: 4, caseTerminalKind: "done" })).toBe("done");
  });

  it("reads stage roles and stage task references leniently", () => {
    expect(readStageFlowConfig({ flow: { author: "  ", verifier: { userId: "u1" }, maxReviewRounds: 0 } })).toEqual({
      author: null,
      verifier: { agentId: null, userId: "u1", label: null },
      maxReviewRounds: null,
    });
    expect(readStageFlowConfig({})).toEqual({ author: null, verifier: null, maxReviewRounds: null });
    expect([...readStageIssueRefs({ stageIssues: { a: "OPT-1", b: 3, c: "" } })]).toEqual([["a", "OPT-1"]]);
  });
});
