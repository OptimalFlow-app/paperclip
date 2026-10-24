import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueExecutionDecisions,
  issues,
  issueThreadInteractions,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelines,
  pipelineStages,
} from "@paperclipai/db";
import type {
  IssueExecutionDecisionOutcome,
  IssueExecutionPolicy,
  IssueExecutionStagePrincipal,
  IssueStatus,
  ProjectFlowCase,
  ProjectFlowDecision,
  ProjectFlowIssue,
  ProjectFlowPipeline,
  ProjectFlowPrincipal,
  ProjectFlowResponse,
  ProjectFlowRoleRef,
  ProjectFlowStage,
  ProjectFlowStageKind,
  ProjectFlowStep,
  ProjectFlowStepState,
} from "@paperclipai/shared";
import {
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
  resolveMaxReviewRounds,
} from "./issue-execution-policy.js";

export const PROJECT_FLOW_MAX_CASES_PER_PIPELINE = 200;
const DECISION_BODY_EXCERPT_CHARS = 160;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProjectFlowPipelineRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
}

export interface ProjectFlowStageRow {
  id: string;
  pipelineId: string;
  key: string;
  name: string;
  kind: string;
  position: number;
  config: Record<string, unknown>;
}

export interface ProjectFlowCaseRow {
  id: string;
  pipelineId: string;
  stageId: string;
  caseKey: string;
  title: string;
  fields: Record<string, unknown>;
  terminalKind: string | null;
  updatedAt: Date;
}

export interface ProjectFlowLinkRow {
  caseId: string;
  issueId: string;
  role: string;
}

export interface ProjectFlowIssueRow {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionPolicy: unknown;
  executionState: unknown;
}

export interface ProjectFlowDecisionRow {
  id: string;
  issueId: string;
  outcome: string;
  actorAgentId: string | null;
  actorUserId: string | null;
  body: string;
  createdAt: Date;
}

export interface ProjectFlowInteractionRow {
  issueId: string;
  addresseeAgentId: string | null;
  addresseeUserId: string | null;
}

export interface ProjectFlowRows {
  pipelines: ProjectFlowPipelineRow[];
  stages: ProjectFlowStageRow[];
  cases: ProjectFlowCaseRow[];
  links: ProjectFlowLinkRow[];
  issues: ProjectFlowIssueRow[];
  decisions: ProjectFlowDecisionRow[];
  pendingInteractions: ProjectFlowInteractionRow[];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readRoleRef(value: unknown): ProjectFlowRoleRef | null {
  if (typeof value === "string") {
    const label = readString(value);
    return label ? { agentId: null, userId: null, label } : null;
  }
  const record = readRecord(value);
  if (!record) return null;
  const ref = {
    agentId: readString(record.agentId),
    userId: readString(record.userId),
    label: readString(record.label),
  };
  return ref.agentId || ref.userId || ref.label ? ref : null;
}

/** Stage roles live under `config.flow` so they never collide with automation keys. */
export function readStageFlowConfig(config: Record<string, unknown>) {
  const flow = readRecord(config.flow) ?? {};
  const max = flow.maxReviewRounds;
  return {
    author: readRoleRef(flow.author),
    verifier: readRoleRef(flow.verifier),
    maxReviewRounds: typeof max === "number" && Number.isInteger(max) && max > 0 ? max : null,
  };
}

/** `fields.stageIssues`: stage key → issue id or identifier. */
export function readStageIssueRefs(fields: Record<string, unknown>): Map<string, string> {
  const refs = new Map<string, string>();
  const record = readRecord(fields.stageIssues);
  if (!record) return refs;
  for (const [stageKey, value] of Object.entries(record)) {
    const ref = readString(value);
    if (ref) refs.set(stageKey, ref);
  }
  return refs;
}

function toPrincipal(input: IssueExecutionStagePrincipal | null | undefined): ProjectFlowPrincipal | null {
  if (!input) return null;
  if (input.type === "agent" && input.agentId) return { type: "agent", agentId: input.agentId, userId: null };
  if (input.type === "user" && input.userId) return { type: "user", agentId: null, userId: input.userId };
  return null;
}

function principalKey(principal: ProjectFlowPrincipal) {
  return principal.type === "agent" ? `agent:${principal.agentId}` : `user:${principal.userId ?? ""}`;
}

function safeExecutionPolicy(input: unknown): IssueExecutionPolicy | null {
  try {
    return normalizeIssueExecutionPolicy(input);
  } catch {
    return null;
  }
}

function excerpt(body: string): string {
  // Plain-text preview: drop the markdown emphasis/code markers before folding whitespace.
  const flat = body.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
  return flat.length > DECISION_BODY_EXCERPT_CHARS ? `${flat.slice(0, DECISION_BODY_EXCERPT_CHARS - 1)}…` : flat;
}

function buildIssue(
  row: ProjectFlowIssueRow,
  decisionRows: ProjectFlowDecisionRow[],
  interactionRows: ProjectFlowInteractionRow[],
  stageMaxRounds: number | null,
): ProjectFlowIssue {
  const policy = safeExecutionPolicy(row.executionPolicy);
  const state = parseIssueExecutionState(row.executionState);
  const decisions: ProjectFlowDecision[] = decisionRows.map((decision) => ({
    id: decision.id,
    outcome: decision.outcome as IssueExecutionDecisionOutcome,
    actorAgentId: decision.actorAgentId,
    actorUserId: decision.actorUserId,
    bodyExcerpt: excerpt(decision.body),
    createdAt: decision.createdAt.toISOString(),
  }));

  const waitingOn: ProjectFlowPrincipal[] = [];
  const seen = new Set<string>();
  const addWaiting = (principal: ProjectFlowPrincipal | null) => {
    if (!principal || seen.has(principalKey(principal))) return;
    seen.add(principalKey(principal));
    waitingOn.push(principal);
  };
  if (row.status === "in_review") addWaiting(toPrincipal(state?.currentParticipant));
  // A pending question without an addressee waits on the board.
  for (const interaction of interactionRows) {
    addWaiting(
      interaction.addresseeAgentId
        ? { type: "agent", agentId: interaction.addresseeAgentId, userId: null }
        : { type: "user", agentId: null, userId: interaction.addresseeUserId },
    );
  }

  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    status: row.status as IssueStatus,
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
    hasReview: (policy?.stages.length ?? 0) > 0 || decisions.length > 0,
    roundsUsed: decisions.filter((decision) => decision.outcome === "changes_requested").length,
    maxRounds: stageMaxRounds ?? resolveMaxReviewRounds(policy),
    decisions,
    waitingOn,
  };
}

function issueState(issue: ProjectFlowIssue): ProjectFlowStepState | null {
  switch (issue.status) {
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
    case "blocked":
      return "blocked";
    case "in_review":
      return "waiting";
    default:
      if (issue.waitingOn.length > 0) return "waiting";
      return issue.status === "in_progress" ? "active" : null;
  }
}

/**
 * State of one stage for a case. The case position is the source of truth for
 * progress: stages before it are validated, stages after it are not started.
 * A task mapped to the stage refines the current and later stages (active,
 * waiting on someone, blocked, already done).
 */
export function stepState(input: {
  index: number;
  currentIndex: number;
  stageKind: ProjectFlowStageKind;
  caseTerminalKind: "done" | "cancelled" | null;
  issue: ProjectFlowIssue | null;
  /** The case's main task, when it is not already the step task. */
  originIssue?: ProjectFlowIssue | null;
}): ProjectFlowStepState {
  if (input.caseTerminalKind === "done") return "done";
  if (input.currentIndex >= 0 && input.index < input.currentIndex) return "done";
  const fromIssue = input.issue ? issueState(input.issue) : null;
  if (input.index === input.currentIndex) {
    if (input.caseTerminalKind === "cancelled") return "cancelled";
    if (input.stageKind === "done") return "done";
    // The stage task is finished but the case has not moved on: the stage
    // still waits for its validation, often a card on the main task.
    if (fromIssue === "done") {
      const fromOrigin = input.originIssue ? issueState(input.originIssue) : null;
      return fromOrigin === "blocked" ? "blocked" : "waiting";
    }
    if (fromIssue) return fromIssue;
    return input.stageKind === "review" ? "waiting" : "active";
  }
  return fromIssue === "done" || fromIssue === "active" || fromIssue === "waiting" || fromIssue === "blocked"
    ? fromIssue
    : "not_started";
}

function groupBy<T>(rows: T[], key: (row: T) => string) {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(key(row)) ?? [];
    list.push(row);
    map.set(key(row), list);
  }
  return map;
}

/**
 * Pure assembly of the project flow from already-loaded rows. `issues` must
 * only hold tasks the actor may read: a stage pointing to any other task is
 * shown without it.
 */
export function buildProjectFlow(projectId: string, rows: ProjectFlowRows): ProjectFlowResponse {
  const issueById = new Map(rows.issues.map((issue) => [issue.id, issue]));
  const issueByIdentifier = new Map(
    rows.issues.filter((issue) => issue.identifier).map((issue) => [issue.identifier!.toUpperCase(), issue]),
  );
  const resolveIssue = (ref: string) =>
    UUID_RE.test(ref) ? issueById.get(ref) ?? null : issueByIdentifier.get(ref.toUpperCase()) ?? null;
  const decisionsByIssue = groupBy(rows.decisions, (row) => row.issueId);
  const interactionsByIssue = groupBy(rows.pendingInteractions, (row) => row.issueId);
  const stagesByPipeline = groupBy(rows.stages, (row) => row.pipelineId);
  const casesByPipeline = groupBy(rows.cases, (row) => row.pipelineId);
  const linksByCase = groupBy(rows.links, (row) => row.caseId);

  const pipelinesOut: ProjectFlowPipeline[] = rows.pipelines.map((pipeline) => {
    const allStages = [...(stagesByPipeline.get(pipeline.id) ?? [])]
      .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
    const stages: ProjectFlowStage[] = allStages
      .filter((stage) => stage.kind !== "cancelled")
      .map((stage) => ({
        id: stage.id,
        key: stage.key,
        name: stage.name,
        kind: stage.kind as ProjectFlowStageKind,
        position: stage.position,
        ...readStageFlowConfig(stage.config),
      }));
    const cancelledStageIds = new Set(allStages.filter((stage) => stage.kind === "cancelled").map((stage) => stage.id));

    const cases: ProjectFlowCase[] = (casesByPipeline.get(pipeline.id) ?? []).map((row) => {
      const terminalKind = row.terminalKind === "done" || row.terminalKind === "cancelled"
        ? row.terminalKind
        : cancelledStageIds.has(row.stageId) ? "cancelled" : null;
      const currentIndex = stages.findIndex((stage) => stage.id === row.stageId);
      const originLink = (linksByCase.get(row.id) ?? []).find((link) => link.role === "origin");
      const originRow = originLink ? issueById.get(originLink.issueId) ?? null : null;
      const stageRefs = readStageIssueRefs(row.fields);

      const steps: ProjectFlowStep[] = stages.map((stage, index) => {
        const ref = stageRefs.get(stage.key);
        const stageRow = ref ? resolveIssue(ref) : null;
        // A case that is one task through every stage (a content) has no
        // per-stage task: its main task speaks for the current stage.
        const issueRow = stageRow ?? (index === currentIndex && !terminalKind ? originRow : null);
        const issue = issueRow
          ? buildIssue(
            issueRow,
            decisionsByIssue.get(issueRow.id) ?? [],
            interactionsByIssue.get(issueRow.id) ?? [],
            stage.maxReviewRounds,
          )
          : null;
        const origin = index === currentIndex && originRow && originRow.id !== issueRow?.id
          ? buildIssue(originRow, [], interactionsByIssue.get(originRow.id) ?? [], null)
          : null;
        const state = stepState({
          index,
          currentIndex,
          stageKind: stage.kind,
          caseTerminalKind: terminalKind,
          issue,
          originIssue: origin,
        });
        const underWay = state === "active" || state === "waiting" || state === "blocked";
        return {
          stageId: stage.id,
          state,
          issue,
          issueSource: stageRow ? "stage" : issue ? "origin" : null,
          waitingOn: !underWay
            ? []
            : issue && issue.status !== "done"
              ? issue.waitingOn
              : origin?.waitingOn ?? [],
        };
      });

      return {
        id: row.id,
        caseKey: row.caseKey,
        title: row.title,
        currentStageId: row.stageId,
        terminalKind,
        updatedAt: row.updatedAt.toISOString(),
        originIssue: originRow
          ? { id: originRow.id, identifier: originRow.identifier, title: originRow.title }
          : null,
        steps,
        progress: {
          done: steps.filter((step) => step.state === "done").length,
          total: steps.length,
        },
      };
    });

    return { id: pipeline.id, key: pipeline.key, name: pipeline.name, description: pipeline.description, stages, cases };
  });

  return { projectId, pipelines: pipelinesOut };
}

export function projectFlowService(db: Db) {
  return {
    /**
     * Loads the active pipelines of a project with their stages, visible cases
     * and every task those cases point to (origin link or `fields.stageIssues`),
     * plus the review decisions and open questions of those tasks. Issue access
     * filtering is the caller's job.
     */
    getProjectFlowRows: async (project: { id: string; companyId: string }): Promise<ProjectFlowRows> => {
      const companyId = project.companyId;
      const pipelineRows = await db
        .select({ id: pipelines.id, key: pipelines.key, name: pipelines.name, description: pipelines.description })
        .from(pipelines)
        .where(and(eq(pipelines.companyId, companyId), eq(pipelines.projectId, project.id), isNull(pipelines.archivedAt)))
        .orderBy(asc(pipelines.createdAt));
      const empty: ProjectFlowRows = {
        pipelines: pipelineRows,
        stages: [],
        cases: [],
        links: [],
        issues: [],
        decisions: [],
        pendingInteractions: [],
      };
      if (pipelineRows.length === 0) return empty;
      const pipelineIds = pipelineRows.map((pipeline) => pipeline.id);

      const [stages, caseRows] = await Promise.all([
        db
          .select({
            id: pipelineStages.id,
            pipelineId: pipelineStages.pipelineId,
            key: pipelineStages.key,
            name: pipelineStages.name,
            kind: pipelineStages.kind,
            position: pipelineStages.position,
            config: pipelineStages.config,
          })
          .from(pipelineStages)
          .where(inArray(pipelineStages.pipelineId, pipelineIds)),
        db
          .select({
            id: pipelineCases.id,
            pipelineId: pipelineCases.pipelineId,
            stageId: pipelineCases.stageId,
            caseKey: pipelineCases.caseKey,
            title: pipelineCases.title,
            fields: pipelineCases.fields,
            terminalKind: pipelineCases.terminalKind,
            updatedAt: pipelineCases.updatedAt,
          })
          .from(pipelineCases)
          .where(and(
            eq(pipelineCases.companyId, companyId),
            inArray(pipelineCases.pipelineId, pipelineIds),
            isNull(pipelineCases.retiredAt),
            isNull(pipelineCases.hiddenFromBoardAt),
          ))
          .orderBy(asc(pipelineCases.createdAt)),
      ]);
      const perPipeline = new Map<string, number>();
      const cases = caseRows.filter((row) => {
        const count = (perPipeline.get(row.pipelineId) ?? 0) + 1;
        perPipeline.set(row.pipelineId, count);
        return count <= PROJECT_FLOW_MAX_CASES_PER_PIPELINE;
      });
      if (cases.length === 0) return { ...empty, stages };

      const links = await db
        .select({ caseId: pipelineCaseIssueLinks.caseId, issueId: pipelineCaseIssueLinks.issueId, role: pipelineCaseIssueLinks.role })
        .from(pipelineCaseIssueLinks)
        .where(and(
          eq(pipelineCaseIssueLinks.companyId, companyId),
          inArray(pipelineCaseIssueLinks.caseId, cases.map((row) => row.id)),
          eq(pipelineCaseIssueLinks.role, "origin"),
          isNull(pipelineCaseIssueLinks.retiredAt),
        ));

      const issueIds = new Set(links.map((link) => link.issueId));
      const identifiers = new Set<string>();
      for (const row of cases) {
        for (const ref of readStageIssueRefs(row.fields).values()) {
          if (UUID_RE.test(ref)) issueIds.add(ref);
          else identifiers.add(ref.toUpperCase());
        }
      }
      if (issueIds.size === 0 && identifiers.size === 0) return { ...empty, stages, cases, links };

      const issueRows = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          parentId: issues.parentId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          executionPolicy: issues.executionPolicy,
          executionState: issues.executionState,
        })
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          isNull(issues.hiddenAt),
          or(
            issueIds.size > 0 ? inArray(issues.id, [...issueIds]) : undefined,
            identifiers.size > 0 ? inArray(issues.identifier, [...identifiers]) : undefined,
          ),
        ));
      const loadedIds = issueRows.map((row) => row.id);
      if (loadedIds.length === 0) return { ...empty, stages, cases, links };

      const [decisions, pendingInteractions] = await Promise.all([
        db
          .select({
            id: issueExecutionDecisions.id,
            issueId: issueExecutionDecisions.issueId,
            outcome: issueExecutionDecisions.outcome,
            actorAgentId: issueExecutionDecisions.actorAgentId,
            actorUserId: issueExecutionDecisions.actorUserId,
            body: issueExecutionDecisions.body,
            createdAt: issueExecutionDecisions.createdAt,
          })
          .from(issueExecutionDecisions)
          .where(and(eq(issueExecutionDecisions.companyId, companyId), inArray(issueExecutionDecisions.issueId, loadedIds)))
          .orderBy(asc(issueExecutionDecisions.createdAt)),
        db
          .select({
            issueId: issueThreadInteractions.issueId,
            addresseeAgentId: issueThreadInteractions.addresseeAgentId,
            addresseeUserId: issueThreadInteractions.addresseeUserId,
          })
          .from(issueThreadInteractions)
          .where(and(
            eq(issueThreadInteractions.companyId, companyId),
            inArray(issueThreadInteractions.issueId, loadedIds),
            eq(issueThreadInteractions.status, "pending"),
          ))
          .orderBy(asc(issueThreadInteractions.createdAt)),
      ]);

      return { pipelines: pipelineRows, stages, cases, links, issues: issueRows, decisions, pendingInteractions };
    },
  };
}
