import type {
  IssueExecutionDecisionOutcome,
  IssueExecutionStageType,
  IssueExecutionStateStatus,
  IssueStatus,
} from "../constants.js";

/**
 * Read model behind the task "flow" view: a task, its nested sub-tasks, and
 * the review/approval loops recorded on each of them. Served by
 * `GET /api/issues/:id/flow-tree`.
 */

export interface IssueFlowPrincipal {
  type: "agent" | "user";
  agentId: string | null;
  userId: string | null;
}

export type IssueFlowContributorRole = "author" | "reviewer" | "approver";

export interface IssueFlowContributor extends IssueFlowPrincipal {
  role: IssueFlowContributorRole;
}

export interface IssueFlowDecision {
  id: string;
  stageId: string;
  stageType: IssueExecutionStageType;
  outcome: IssueExecutionDecisionOutcome;
  actorAgentId: string | null;
  actorUserId: string | null;
  /** First characters of the decision comment, for the round history tooltip. */
  bodyExcerpt: string;
  createdAt: string;
}

export type IssueFlowStageStatus = "pending" | "active" | "completed";

export interface IssueFlowStage {
  id: string;
  type: IssueExecutionStageType;
  participants: IssueFlowPrincipal[];
  status: IssueFlowStageStatus;
  /** Recorded "changes requested" decisions on this stage. */
  roundsUsed: number;
  /** Rounds allowed before escalation (`executionPolicy.maxReviewRounds`, 3 by default). */
  maxRounds: number;
  decisions: IssueFlowDecision[];
}

export interface IssueFlowNode {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  parentId: string | null;
  depth: number;
  createdAt: string;
  completedAt: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  /** Blockers of this task that are part of the same tree. */
  blockedBy: Array<{ id: string; identifier: string | null }>;
  executionState: {
    status: IssueExecutionStateStatus;
    currentStageId: string | null;
    currentStageType: IssueExecutionStageType | null;
    currentParticipant: IssueFlowPrincipal | null;
    returnAssignee: IssueFlowPrincipal | null;
  } | null;
  stages: IssueFlowStage[];
  /**
   * Pending questions or confirmation requests on the task. `addressee` is
   * null when anyone on the board may answer.
   */
  pendingConfirmations: Array<{ id: string; kind: string; addressee: IssueFlowPrincipal | null }>;
  /** Who produced, reviewed or approved the task (from execution state and decisions). */
  contributors: IssueFlowContributor[];
}

export interface IssueFlowTreeResponse {
  rootIssueId: string;
  nodes: IssueFlowNode[];
  truncated: boolean;
  caps: { maxDepth: number; maxNodes: number };
}
