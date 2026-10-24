import type { IssueExecutionDecisionOutcome, IssueStatus } from "../constants.js";

/**
 * Read model behind the project "Flow" tab: every pipeline of a project, its
 * ordered stages, and one row per case (deliverable) showing where it stands
 * on each stage — including stages that have no task yet. Served by
 * `GET /api/projects/:id/flow`.
 *
 * Stage roles come from `pipeline_stages.config.flow`:
 * `{ author?, verifier?, maxReviewRounds? }`, where a role is
 * `{ agentId }`, `{ userId }` or `{ label }`. A case points a stage to its
 * task through `pipeline_cases.fields.stageIssues`:
 * `{ "<stageKey>": "<issue id or identifier>" }`.
 */

export interface ProjectFlowPrincipal {
  type: "agent" | "user";
  agentId: string | null;
  /** Null for a user principal means the board as a whole. */
  userId: string | null;
}

/** Who produces or checks a stage: an agent, a user, or a free label. */
export interface ProjectFlowRoleRef {
  agentId: string | null;
  userId: string | null;
  label: string | null;
}

export type ProjectFlowStageKind = "working" | "review" | "done";

export interface ProjectFlowStage {
  id: string;
  key: string;
  name: string;
  kind: ProjectFlowStageKind;
  position: number;
  author: ProjectFlowRoleRef | null;
  verifier: ProjectFlowRoleRef | null;
  maxReviewRounds: number | null;
}

export type ProjectFlowStepState = "done" | "active" | "waiting" | "blocked" | "not_started" | "cancelled";

export interface ProjectFlowDecision {
  id: string;
  outcome: IssueExecutionDecisionOutcome;
  actorAgentId: string | null;
  actorUserId: string | null;
  /** First characters of the decision comment, for the round history tooltip. */
  bodyExcerpt: string;
  createdAt: string;
}

export interface ProjectFlowIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  /** True when the task has a review/approval loop to show. */
  hasReview: boolean;
  /** Recorded "changes requested" decisions. */
  roundsUsed: number;
  maxRounds: number;
  decisions: ProjectFlowDecision[];
  /** Who must confirm for the task to move on (reviewer, approver, question addressee). */
  waitingOn: ProjectFlowPrincipal[];
}

export interface ProjectFlowStep {
  stageId: string;
  state: ProjectFlowStepState;
  issue: ProjectFlowIssue | null;
  /** `stage`: the task mapped to this stage; `origin`: the case's main task, shown on its current stage. */
  issueSource: "stage" | "origin" | null;
  /**
   * Who must confirm for the step to move on: the step task's reviewer or
   * question addressee, or — once that task is done but the case has not
   * moved yet — whoever the case's main task waits on.
   */
  waitingOn: ProjectFlowPrincipal[];
}

export interface ProjectFlowIssueRef {
  id: string;
  identifier: string | null;
  title: string;
}

export interface ProjectFlowCase {
  id: string;
  caseKey: string;
  title: string;
  currentStageId: string;
  terminalKind: "done" | "cancelled" | null;
  updatedAt: string;
  originIssue: ProjectFlowIssueRef | null;
  steps: ProjectFlowStep[];
  progress: { done: number; total: number };
}

export interface ProjectFlowPipeline {
  id: string;
  key: string;
  name: string;
  description: string | null;
  stages: ProjectFlowStage[];
  cases: ProjectFlowCase[];
}

export interface ProjectFlowResponse {
  projectId: string;
  pipelines: ProjectFlowPipeline[];
}
