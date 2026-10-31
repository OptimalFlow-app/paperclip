import { describe, expect, it } from "vitest";
import {
  decideBatchAdmission,
  decideBatchedWakeRevalidation,
  decideBatchFlush,
  type BatchAdmissionFacts,
  type BatchedWakeRevalidationFacts,
} from "./policy.js";

const baseAdmission: BatchAdmissionFacts = {
  batchWindowSec: 300,
  source: "assignment",
  hasIssue: true,
  activeExecutionRunPresent: false,
  requestedByActorType: "agent",
  issuePriority: "medium",
  requiresDedicatedRun: false,
};

describe("decideBatchAdmission", () => {
  const cases: Array<{ name: string; facts: Partial<BatchAdmissionFacts>; expected: ReturnType<typeof decideBatchAdmission> }> = [
    { name: "batches an agent wake on an idle issue", facts: {}, expected: { kind: "batch" } },
    { name: "batches a system wake", facts: { requestedByActorType: "system", source: "automation" }, expected: { kind: "batch" } },
    { name: "a window of 0 keeps the ordinary path", facts: { batchWindowSec: 0 }, expected: { kind: "immediate", reason: "window_disabled" } },
    { name: "a missing window keeps the ordinary path", facts: { batchWindowSec: Number.NaN }, expected: { kind: "immediate", reason: "window_disabled" } },
    { name: "a negative window keeps the ordinary path", facts: { batchWindowSec: -5 }, expected: { kind: "immediate", reason: "window_disabled" } },
    { name: "timer wakes are never batched", facts: { source: "timer" }, expected: { kind: "immediate", reason: "timer" } },
    { name: "wakes without an issue are never batched", facts: { hasIssue: false }, expected: { kind: "immediate", reason: "no_issue" } },
    { name: "an active execution run keeps the per-issue path", facts: { activeExecutionRunPresent: true }, expected: { kind: "immediate", reason: "active_execution_run" } },
    { name: "a user wake bypasses the window", facts: { requestedByActorType: "user" }, expected: { kind: "immediate", reason: "user_actor" } },
    { name: "a critical issue bypasses the window", facts: { issuePriority: "critical" }, expected: { kind: "immediate", reason: "critical_issue" } },
    { name: "a wake with a dedicated-run contract bypasses the window", facts: { requiresDedicatedRun: true }, expected: { kind: "immediate", reason: "dedicated_run" } },
    {
      name: "the disabled window wins over every other rule",
      facts: { batchWindowSec: 0, requestedByActorType: "user", issuePriority: "critical", source: "timer" },
      expected: { kind: "immediate", reason: "window_disabled" },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideBatchAdmission({ ...baseAdmission, ...testCase.facts })).toEqual(testCase.expected);
    });
  }
});

describe("decideBatchFlush", () => {
  const now = 1_000_000;
  it("waits while the window is open", () => {
    expect(decideBatchFlush({ batchWindowSec: 300, oldestRequestedAtMs: now - 299_000, nowMs: now, agentHasActiveRun: false }))
      .toEqual({ kind: "wait", reason: "window_open" });
  });
  it("flushes once the window has elapsed and the agent is idle", () => {
    expect(decideBatchFlush({ batchWindowSec: 300, oldestRequestedAtMs: now - 300_000, nowMs: now, agentHasActiveRun: false }))
      .toEqual({ kind: "flush" });
  });
  it("waits for the agent's active run to finish", () => {
    expect(decideBatchFlush({ batchWindowSec: 300, oldestRequestedAtMs: now - 600_000, nowMs: now, agentHasActiveRun: true }))
      .toEqual({ kind: "wait", reason: "agent_busy" });
  });
  it("flushes at once when the window was turned off after admission", () => {
    expect(decideBatchFlush({ batchWindowSec: 0, oldestRequestedAtMs: now, nowMs: now, agentHasActiveRun: false }))
      .toEqual({ kind: "flush" });
  });
});

const baseRevalidation: BatchedWakeRevalidationFacts = {
  issueFound: true,
  issueStatus: "todo",
  assigneeAgentIdAtAdmission: "agent-1",
  currentAssigneeAgentId: "agent-1",
  commentIdCount: 0,
  liveCommentIdCount: 0,
  preservesIndependentContinuation: true,
};

describe("decideBatchedWakeRevalidation", () => {
  const cases: Array<{ name: string; facts: Partial<BatchedWakeRevalidationFacts>; expected: ReturnType<typeof decideBatchedWakeRevalidation> }> = [
    { name: "delivers an unchanged wake", facts: {}, expected: { kind: "deliver" } },
    { name: "cancels a wake whose issue is done", facts: { issueStatus: "done" }, expected: { kind: "cancel", reason: "batch_issue_closed" } },
    { name: "cancels a wake whose issue is cancelled", facts: { issueStatus: "cancelled" }, expected: { kind: "cancel", reason: "batch_issue_closed" } },
    { name: "cancels a wake whose issue disappeared", facts: { issueFound: false }, expected: { kind: "cancel", reason: "batch_issue_closed" } },
    { name: "cancels a wake whose issue was reassigned", facts: { currentAssigneeAgentId: "agent-2" }, expected: { kind: "cancel", reason: "batch_reassigned" } },
    { name: "cancels a wake whose issue was unassigned", facts: { currentAssigneeAgentId: null }, expected: { kind: "cancel", reason: "batch_reassigned" } },
    {
      name: "cancels a comment-only wake whose comments were all deleted",
      facts: { commentIdCount: 2, liveCommentIdCount: 0, preservesIndependentContinuation: false },
      expected: { kind: "cancel", reason: "batch_comments_deleted" },
    },
    {
      name: "delivers a comment wake with one remaining comment",
      facts: { commentIdCount: 2, liveCommentIdCount: 1, preservesIndependentContinuation: false },
      expected: { kind: "deliver" },
    },
    {
      name: "delivers a wake with an independent reason even when its comments were deleted",
      facts: { commentIdCount: 1, liveCommentIdCount: 0, preservesIndependentContinuation: true },
      expected: { kind: "deliver" },
    },
    { name: "delivers an in_review wake", facts: { issueStatus: "in_review" }, expected: { kind: "deliver" } },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideBatchedWakeRevalidation({ ...baseRevalidation, ...testCase.facts })).toEqual(testCase.expected);
    });
  }
});
