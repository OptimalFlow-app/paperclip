import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  DEFAULT_CONTINUATION_HISTORY_COMMENTS,
  buildExecutionContinuation,
  resolveContinuationHistoryLimit,
} from "./execution-continuation.js";

const COMMENT_COUNT = 60;
const SUMMARY = "Continuation summary: steps 1-40 are done; the migration is merged.";
const commentAt = (index: number) => new Date(Date.UTC(2026, 9, 1, 10, index));
const bodyOf = (index: number) => `Thread comment #${String(index).padStart(2, "0")}`;

describe("resolveContinuationHistoryLimit", () => {
  it("reads heartbeat.continuationHistory.maxComments with a documented default", () => {
    expect(DEFAULT_CONTINUATION_HISTORY_COMMENTS).toBe(15);
    expect(resolveContinuationHistoryLimit({})).toBe(15);
    expect(resolveContinuationHistoryLimit({ heartbeat: { continuationHistory: { maxComments: 25 } } })).toBe(25);
    expect(resolveContinuationHistoryLimit({ heartbeat: { continuationHistory: { maxComments: "8" } } })).toBe(8);
    expect(resolveContinuationHistoryLimit({ heartbeat: { continuationHistory: { maxComments: 0 } } })).toBe(0);
    expect(resolveContinuationHistoryLimit({ heartbeat: { continuationHistory: { maxComments: -3 } } })).toBe(15);
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("bounded continuation history", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID(), issueId = randomUUID();
  const commentIds: string[] = Array.from({ length: COMMENT_COUNT }, () => randomUUID());

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-continuation-bound-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Bounded", issuePrefix: "BND" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Executor", role: "engineer", adapterType: "claude_local" },
      { id: otherAgentId, companyId, name: "Reviewer", role: "engineer", adapterType: "claude_local" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Long thread", description: "Ship it.",
      status: "in_progress", assigneeAgentId: agentId });
    // Agent-authored chatter, with one old user request (#00) that triggers the wake.
    await db.insert(issueComments).values(commentIds.map((id, index) => ({
      id, companyId, issueId, body: bodyOf(index), createdAt: commentAt(index),
      ...(index === 0 ? { authorType: "user" as const, authorUserId: "local-board" } : { authorType: "agent" as const, authorAgentId: otherAgentId }),
    })));
  }, 60_000);
  afterAll(async () => {
    await database?.cleanup();
  });

  const build = (context: Record<string, unknown>, extra: Partial<Parameters<typeof buildExecutionContinuation>[0]> = {}) =>
    buildExecutionContinuation({ db, companyId, issueId, agentId, context, summary: SUMMARY, exposeLowTrustRaw: false,
      maxHistoryComments: DEFAULT_CONTINUATION_HISTORY_COMMENTS, ...extra });
  const promptComments = (prompt: string) => [...prompt.matchAll(/Thread comment #(\d\d)/g)].map(match => Number(match[1]));

  it("gives a fresh session at most N comments plus the summary and its wake comments", async () => {
    const envelope = await build({ wakeReason: "issue_assigned", commentId: commentIds[0] });
    const kept = envelope.messages.map(message => commentIds.indexOf(message.id));
    // The 15 latest comments plus the old wake comment, in thread order.
    expect(kept).toEqual([0, ...Array.from({ length: 15 }, (_, offset) => COMMENT_COUNT - 15 + offset)]);
    expect(envelope.coverage).toEqual({
      kind: "bounded_task_history",
      throughCommentId: commentIds[COMMENT_COUNT - 1],
      summaryThroughCommentId: null,
      omittedCommentCount: COMMENT_COUNT - 16,
      omittedThroughCommentId: commentIds[COMMENT_COUNT - 16],
    });
    expect(envelope.completedWork).toBe(SUMMARY);

    const prompt = renderPaperclipWakePrompt({ executionContinuation: envelope }, { resumedSession: false });
    const inPrompt = new Set(promptComments(prompt));
    expect(inPrompt.size).toBeLessThanOrEqual(DEFAULT_CONTINUATION_HISTORY_COMMENTS + 1);
    expect(inPrompt.has(0)).toBe(true);
    expect(inPrompt.has(COMMENT_COUNT - 1)).toBe(true);
    expect(inPrompt.has(10)).toBe(false);
    expect(prompt).toContain("steps 1-40 are done");
    expect(prompt).toContain(`History is bounded: ${COMMENT_COUNT - 16} older comments are omitted`);
  });

  it("keeps an old trigger comment outside the latest N", async () => {
    const oldTrigger = commentIds[5]!;
    const envelope = await build({ wakeReason: "issue_commented", wakeCommentIds: [oldTrigger] });
    expect(envelope.originCommentIds).toContain(oldTrigger);
    expect(envelope.messages.map(message => message.id)).toContain(oldTrigger);
    expect(envelope.messages.find(message => message.id === oldTrigger)?.body).toBe(bodyOf(5));
    // The latest user request also stays, even with no wake reference to it.
    expect(envelope.messages.map(message => message.id)).toContain(commentIds[0]);
    expect(envelope.messages).toHaveLength(DEFAULT_CONTINUATION_HISTORY_COMMENTS + 2);
  });

  it("keeps every comment posted since the agent's previous run, beyond N", async () => {
    const previousRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: previousRunId, companyId, agentId, status: "succeeded",
      contextSnapshot: { issueId }, createdAt: commentAt(20), startedAt: commentAt(20), finishedAt: commentAt(21) });
    try {
      const envelope = await build({ wakeReason: "issue_commented" });
      const kept = envelope.messages.map(message => commentIds.indexOf(message.id));
      expect(kept).toEqual([0, ...Array.from({ length: COMMENT_COUNT - 20 }, (_, offset) => 20 + offset)]);
      expect(envelope.coverage.omittedCommentCount).toBe(19);
    } finally {
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, previousRunId));
    }
  });

  it("does not resend omitted comments through a resume delta", async () => {
    const previousRunId = randomUUID();
    const first = await build({ wakeReason: "issue_assigned", commentId: commentIds[0] });
    await db.insert(heartbeatRuns).values({ id: previousRunId, companyId, agentId, status: "succeeded",
      contextSnapshot: { issueId, executionContinuation: first }, createdAt: commentAt(COMMENT_COUNT), startedAt: commentAt(COMMENT_COUNT) });
    try {
      const resumed = await build({ wakeReason: "issue_commented" }, { previousContextRunId: previousRunId });
      expect(resumed.resumeDelta?.messages.map(message => message.id)).toEqual([]);
    } finally {
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, previousRunId));
    }
  });

  it("keeps the full thread when the bound is disabled", async () => {
    const envelope = await build({ wakeReason: "issue_assigned" }, { maxHistoryComments: 0 });
    expect(envelope.messages).toHaveLength(COMMENT_COUNT);
    expect(envelope.coverage.kind).toBe("full_task_history");
    expect(envelope.coverage.omittedCommentCount).toBeUndefined();
  });
});
