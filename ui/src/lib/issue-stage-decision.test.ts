import { describe, expect, it } from "vitest";
import {
  buildStageDecisionPatch,
  isCurrentUserStageParticipant,
  isStageDecisionStatus,
} from "./issue-stage-decision";

function pendingApproval(userId: string | null, type: "user" | "agent" = "user") {
  return {
    status: "in_review",
    executionState: {
      status: "pending" as const,
      currentStageType: "approval" as const,
      currentParticipant: type === "user"
        ? { type: "user" as const, agentId: null, userId }
        : { type: "agent" as const, agentId: "agent-1", userId: null },
    },
  };
}

describe("isCurrentUserStageParticipant", () => {
  it("is true when the pending stage waits on the signed-in user", () => {
    expect(isCurrentUserStageParticipant(pendingApproval("local-board"), "local-board")).toBe(true);
  });

  it("is false for another user, an agent participant, or no session", () => {
    expect(isCurrentUserStageParticipant(pendingApproval("user-2"), "user-1")).toBe(false);
    expect(isCurrentUserStageParticipant(pendingApproval(null, "agent"), "user-1")).toBe(false);
    expect(isCurrentUserStageParticipant(pendingApproval("user-1"), null)).toBe(false);
  });

  it("is false outside in_review or once the stage is no longer pending", () => {
    expect(isCurrentUserStageParticipant({ ...pendingApproval("user-1"), status: "in_progress" }, "user-1")).toBe(false);
    const changesRequested = pendingApproval("user-1");
    expect(isCurrentUserStageParticipant({
      ...changesRequested,
      executionState: { ...changesRequested.executionState, status: "changes_requested" },
    }, "user-1")).toBe(false);
    expect(isCurrentUserStageParticipant({ status: "in_review", executionState: null }, "user-1")).toBe(false);
  });
});

describe("stage decision helpers", () => {
  it("only treats done and in_progress as decision statuses", () => {
    expect(isStageDecisionStatus("done")).toBe(true);
    expect(isStageDecisionStatus("in_progress")).toBe(true);
    expect(isStageDecisionStatus("blocked")).toBe(false);
    expect(isStageDecisionStatus("cancelled")).toBe(false);
  });

  it("builds a single status + trimmed comment patch", () => {
    expect(buildStageDecisionPatch("done", "  ok  ")).toEqual({ status: "done", comment: "ok" });
  });
});
