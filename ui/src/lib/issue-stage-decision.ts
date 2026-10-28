import type { IssueExecutionState, IssueStatus } from "@paperclipai/shared";

export type IssueStageDecisionStatus = "done" | "in_progress";

interface StageDecisionIssueInput {
  status?: IssueStatus | string | null;
  executionState?: Pick<IssueExecutionState, "status" | "currentParticipant" | "currentStageType"> | null;
}

/**
 * True when the signed-in user is the participant the active review/approval
 * stage is waiting on. In that state the server only accepts a `done` or
 * `in_progress` transition together with a decision comment in the same PATCH
 * (see `server/src/services/issue-execution-policy.ts`), so the UI must route
 * those transitions through the stage decision form instead of a bare status.
 */
export function isCurrentUserStageParticipant(
  issue: StageDecisionIssueInput | null | undefined,
  currentUserId: string | null | undefined,
): boolean {
  if (!issue || !currentUserId) return false;
  if (issue.status !== "in_review") return false;
  const state = issue.executionState;
  if (!state || state.status !== "pending" || !state.currentStageType) return false;
  const participant = state.currentParticipant;
  return participant?.type === "user" && participant.userId === currentUserId;
}

export function isStageDecisionStatus(status: string): status is IssueStageDecisionStatus {
  return status === "done" || status === "in_progress";
}

export function buildStageDecisionPatch(status: IssueStageDecisionStatus, comment: string) {
  return { status, comment: comment.trim() };
}
