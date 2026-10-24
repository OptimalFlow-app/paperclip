import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueExecutionDecisions, issueRelations, issues, issueThreadInteractions } from "@paperclipai/db";
import type {
  IssueExecutionDecisionOutcome,
  IssueExecutionPolicy,
  IssueExecutionStagePrincipal,
  IssueExecutionStageType,
  IssueFlowContributor,
  IssueFlowDecision,
  IssueFlowNode,
  IssueFlowPrincipal,
  IssueFlowStage,
  IssueFlowTreeResponse,
  IssueStatus,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import {
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
  resolveMaxReviewRounds,
} from "./issue-execution-policy.js";

export const ISSUE_FLOW_TREE_MAX_DEPTH = 8;
export const ISSUE_FLOW_TREE_MAX_NODES = 200;
const DECISION_BODY_EXCERPT_CHARS = 160;

export interface IssueFlowTreeIssueRow {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  identifier: string | null;
  title: string;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionPolicy: unknown;
  executionState: unknown;
}

export interface IssueFlowTreeInteractionRow {
  id: string;
  issueId: string;
  kind: string;
  addresseeAgentId: string | null;
  addresseeUserId: string | null;
}

export interface IssueFlowTreeDecisionRow {
  id: string;
  issueId: string;
  stageId: string;
  stageType: string;
  outcome: string;
  actorAgentId: string | null;
  actorUserId: string | null;
  body: string;
  createdAt: Date;
}

const flowTreeIssueColumns = {
  id: issues.id,
  companyId: issues.companyId,
  projectId: issues.projectId,
  parentId: issues.parentId,
  identifier: issues.identifier,
  title: issues.title,
  status: issues.status,
  createdAt: issues.createdAt,
  completedAt: issues.completedAt,
  assigneeAgentId: issues.assigneeAgentId,
  assigneeUserId: issues.assigneeUserId,
  executionPolicy: issues.executionPolicy,
  executionState: issues.executionState,
};

function toPrincipal(input: IssueExecutionStagePrincipal | null | undefined): IssueFlowPrincipal | null {
  if (!input) return null;
  if (input.type === "agent" && input.agentId) return { type: "agent", agentId: input.agentId, userId: null };
  if (input.type === "user" && input.userId) return { type: "user", agentId: null, userId: input.userId };
  return null;
}

function principalKey(principal: IssueFlowPrincipal): string {
  return principal.type === "agent" ? `agent:${principal.agentId}` : `user:${principal.userId}`;
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

function toDecision(row: IssueFlowTreeDecisionRow): IssueFlowDecision {
  return {
    id: row.id,
    stageId: row.stageId,
    stageType: row.stageType as IssueExecutionStageType,
    outcome: row.outcome as IssueExecutionDecisionOutcome,
    actorAgentId: row.actorAgentId,
    actorUserId: row.actorUserId,
    bodyExcerpt: excerpt(row.body),
    createdAt: row.createdAt.toISOString(),
  };
}

function buildNode(
  row: IssueFlowTreeIssueRow,
  depth: number,
  blockedBy: IssueFlowNode["blockedBy"],
  decisionRows: IssueFlowTreeDecisionRow[],
  interactionRows: IssueFlowTreeInteractionRow[],
): IssueFlowNode {
  const policy = safeExecutionPolicy(row.executionPolicy);
  const state = parseIssueExecutionState(row.executionState);
  const maxRounds = resolveMaxReviewRounds(policy);
  const decisions = decisionRows.map(toDecision);
  const completedStageIds = new Set(state?.completedStageIds ?? []);

  const stages: IssueFlowStage[] = (policy?.stages ?? []).map((stage) => {
    const stageDecisions = decisions.filter((decision) => decision.stageId === stage.id);
    return {
      id: stage.id,
      type: stage.type,
      participants: stage.participants
        .map((participant) => toPrincipal(participant))
        .filter((participant): participant is IssueFlowPrincipal => participant !== null),
      status: completedStageIds.has(stage.id)
        ? "completed"
        : state?.currentStageId === stage.id
          ? "active"
          : "pending",
      roundsUsed: stageDecisions.filter((decision) => decision.outcome === "changes_requested").length,
      maxRounds,
      decisions: stageDecisions,
    };
  });

  const contributors: IssueFlowContributor[] = [];
  const seen = new Set<string>();
  const addContributor = (principal: IssueFlowPrincipal | null, role: IssueFlowContributor["role"]) => {
    if (!principal) return;
    const key = `${role}:${principalKey(principal)}`;
    if (seen.has(key)) return;
    seen.add(key);
    contributors.push({ ...principal, role });
  };
  // The author is whoever the review hands work back to; without a review
  // loop, it is the current assignee.
  addContributor(
    toPrincipal(state?.returnAssignee)
      ?? (row.assigneeAgentId
        ? { type: "agent", agentId: row.assigneeAgentId, userId: null }
        : row.assigneeUserId
          ? { type: "user", agentId: null, userId: row.assigneeUserId }
          : null),
    "author",
  );
  for (const decision of decisions) {
    const actor: IssueFlowPrincipal | null = decision.actorAgentId
      ? { type: "agent", agentId: decision.actorAgentId, userId: null }
      : decision.actorUserId
        ? { type: "user", agentId: null, userId: decision.actorUserId }
        : null;
    addContributor(actor, decision.stageType === "approval" ? "approver" : "reviewer");
  }

  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    status: row.status as IssueStatus,
    parentId: depth === 0 ? null : row.parentId,
    depth,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
    blockedBy,
    executionState: state
      ? {
        status: state.status,
        currentStageId: state.currentStageId,
        currentStageType: state.currentStageType,
        currentParticipant: toPrincipal(state.currentParticipant),
        returnAssignee: toPrincipal(state.returnAssignee),
      }
      : null,
    stages,
    pendingConfirmations: interactionRows.map((interaction) => ({
      id: interaction.id,
      kind: interaction.kind,
      addressee: interaction.addresseeAgentId
        ? { type: "agent", agentId: interaction.addresseeAgentId, userId: null }
        : interaction.addresseeUserId
          ? { type: "user", agentId: null, userId: interaction.addresseeUserId }
          : null,
    })),
    contributors,
  };
}

/**
 * Pure assembly of the flow tree from already-loaded rows. `rows` must hold
 * the root first, followed by descendants in breadth-first order. A row whose
 * parent is missing (e.g. filtered out for the actor) is dropped with its
 * whole branch.
 */
export function buildIssueFlowTree(input: {
  rootIssueId: string;
  rows: Array<IssueFlowTreeIssueRow & { depth: number }>;
  relations: Array<{ issueId: string; relatedIssueId: string }>;
  decisions: IssueFlowTreeDecisionRow[];
  pendingInteractions?: IssueFlowTreeInteractionRow[];
  truncated: boolean;
}): IssueFlowTreeResponse {
  const kept: Array<IssueFlowTreeIssueRow & { depth: number }> = [];
  const keptIds = new Set<string>();
  for (const row of input.rows) {
    const isRoot = row.id === input.rootIssueId;
    if (!isRoot && (!row.parentId || !keptIds.has(row.parentId))) continue;
    kept.push(row);
    keptIds.add(row.id);
  }
  const byId = new Map(kept.map((row) => [row.id, row]));
  const blockedByIssueId = new Map<string, IssueFlowNode["blockedBy"]>();
  for (const relation of input.relations) {
    const blocker = byId.get(relation.issueId);
    if (!blocker || !byId.has(relation.relatedIssueId)) continue;
    const list = blockedByIssueId.get(relation.relatedIssueId) ?? [];
    list.push({ id: blocker.id, identifier: blocker.identifier });
    blockedByIssueId.set(relation.relatedIssueId, list);
  }
  const decisionsByIssueId = new Map<string, IssueFlowTreeDecisionRow[]>();
  for (const decision of input.decisions) {
    const list = decisionsByIssueId.get(decision.issueId) ?? [];
    list.push(decision);
    decisionsByIssueId.set(decision.issueId, list);
  }

  const interactionsByIssueId = new Map<string, IssueFlowTreeInteractionRow[]>();
  for (const interaction of input.pendingInteractions ?? []) {
    const list = interactionsByIssueId.get(interaction.issueId) ?? [];
    list.push(interaction);
    interactionsByIssueId.set(interaction.issueId, list);
  }

  return {
    rootIssueId: input.rootIssueId,
    nodes: kept.map((row) =>
      buildNode(
        row,
        row.depth,
        blockedByIssueId.get(row.id) ?? [],
        decisionsByIssueId.get(row.id) ?? [],
        interactionsByIssueId.get(row.id) ?? [],
      ),
    ),
    truncated: input.truncated,
    caps: { maxDepth: ISSUE_FLOW_TREE_MAX_DEPTH, maxNodes: ISSUE_FLOW_TREE_MAX_NODES },
  };
}

export function issueFlowTreeService(db: Db) {
  return {
    /**
     * Loads a task and its visible descendants (bounded by depth and node
     * caps), the blocker relations between them and every recorded
     * review/approval decision. Access filtering is the caller's job.
     */
    getFlowTreeRows: async (rootIssueId: string) => {
      const root = await db
        .select(flowTreeIssueColumns)
        .from(issues)
        .where(eq(issues.id, rootIssueId))
        .then((rows) => rows[0] ?? null);
      if (!root) throw notFound("Issue not found");

      const rows: Array<IssueFlowTreeIssueRow & { depth: number }> = [{ ...root, depth: 0 }];
      const seen = new Set([root.id]);
      let frontier = [root.id];
      let truncated = false;
      for (let depth = 1; depth <= ISSUE_FLOW_TREE_MAX_DEPTH && frontier.length > 0; depth += 1) {
        const children = await db
          .select(flowTreeIssueColumns)
          .from(issues)
          .where(
            and(
              eq(issues.companyId, root.companyId),
              inArray(issues.parentId, frontier),
              isNull(issues.hiddenAt),
              isNull(issues.harnessKind),
            ),
          )
          .orderBy(asc(issues.createdAt), asc(issues.id));
        frontier = [];
        for (const child of children) {
          if (seen.has(child.id)) continue;
          if (rows.length >= ISSUE_FLOW_TREE_MAX_NODES) {
            truncated = true;
            break;
          }
          seen.add(child.id);
          rows.push({ ...child, depth });
          frontier.push(child.id);
        }
        if (truncated) break;
        if (depth === ISSUE_FLOW_TREE_MAX_DEPTH && frontier.length > 0) {
          const deeper = await db
            .select({ id: issues.id })
            .from(issues)
            .where(and(inArray(issues.parentId, frontier), isNull(issues.hiddenAt)))
            .limit(1);
          truncated = deeper.length > 0;
        }
      }

      const ids = rows.map((row) => row.id);
      const [relations, decisions, pendingInteractions] = await Promise.all([
        db
          .select({ issueId: issueRelations.issueId, relatedIssueId: issueRelations.relatedIssueId })
          .from(issueRelations)
          .where(
            and(
              eq(issueRelations.companyId, root.companyId),
              eq(issueRelations.type, "blocks"),
              inArray(issueRelations.relatedIssueId, ids),
            ),
          ),
        db
          .select({
            id: issueExecutionDecisions.id,
            issueId: issueExecutionDecisions.issueId,
            stageId: issueExecutionDecisions.stageId,
            stageType: issueExecutionDecisions.stageType,
            outcome: issueExecutionDecisions.outcome,
            actorAgentId: issueExecutionDecisions.actorAgentId,
            actorUserId: issueExecutionDecisions.actorUserId,
            body: issueExecutionDecisions.body,
            createdAt: issueExecutionDecisions.createdAt,
          })
          .from(issueExecutionDecisions)
          .where(
            and(
              eq(issueExecutionDecisions.companyId, root.companyId),
              inArray(issueExecutionDecisions.issueId, ids),
            ),
          )
          .orderBy(asc(issueExecutionDecisions.createdAt)),
        db
          .select({
            id: issueThreadInteractions.id,
            issueId: issueThreadInteractions.issueId,
            kind: issueThreadInteractions.kind,
            addresseeAgentId: issueThreadInteractions.addresseeAgentId,
            addresseeUserId: issueThreadInteractions.addresseeUserId,
          })
          .from(issueThreadInteractions)
          .where(
            and(
              eq(issueThreadInteractions.companyId, root.companyId),
              inArray(issueThreadInteractions.issueId, ids),
              eq(issueThreadInteractions.status, "pending"),
            ),
          )
          .orderBy(asc(issueThreadInteractions.createdAt)),
      ]);

      return { root, rows, relations, decisions, pendingInteractions, truncated };
    },
  };
}
