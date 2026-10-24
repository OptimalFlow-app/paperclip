import type {
  IssueFlowContributorRole,
  IssueFlowNode,
  IssueFlowPrincipal,
} from "@paperclipai/shared";
import { workflowSort } from "./workflow-sort";

/**
 * Visual state of one task in the flow view. It collapses issue statuses into
 * the five states the board reads at a glance.
 */
export type FlowNodeState = "validated" | "active" | "waiting" | "blocked" | "not_started" | "cancelled";

/** Base hue for each flow state, taken from the shared task status tokens. */
export const flowNodeStateVar: Record<FlowNodeState, string> = {
  validated: "--status-task-done",
  active: "--status-task-in_progress",
  waiting: "--status-task-in_review",
  blocked: "--status-task-blocked",
  not_started: "--status-task-backlog",
  cancelled: "--status-task-cancelled",
};

export const flowNodeStateLabel: Record<FlowNodeState, string> = {
  validated: "Validated",
  active: "In progress",
  waiting: "Waiting for confirmation",
  blocked: "Blocked",
  not_started: "Not started",
  cancelled: "Cancelled",
};

export function flowNodeState(node: Pick<IssueFlowNode, "status">, hasLiveRun: boolean): FlowNodeState {
  switch (node.status) {
    case "done":
      return "validated";
    case "cancelled":
      return "cancelled";
    case "blocked":
      return "blocked";
    case "in_review":
      return "waiting";
    case "in_progress":
      return "active";
    default:
      return hasLiveRun ? "active" : "not_started";
  }
}

export interface FlowTreeItem {
  node: IssueFlowNode;
  children: FlowTreeItem[];
}

/**
 * Nests the flat node list under the root. Siblings follow the blocker chain
 * (`blockedBy`), then creation order.
 */
export function buildFlowTreeItems(nodes: IssueFlowNode[], rootIssueId: string): FlowTreeItem | null {
  const root = nodes.find((node) => node.id === rootIssueId);
  if (!root) return null;
  const childrenByParent = new Map<string, IssueFlowNode[]>();
  for (const node of nodes) {
    if (node.id === rootIssueId || !node.parentId) continue;
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }
  const build = (node: IssueFlowNode, ancestors: Set<string>): FlowTreeItem => {
    const next = new Set(ancestors).add(node.id);
    const children = workflowSort(childrenByParent.get(node.id) ?? [])
      .filter((child) => !next.has(child.id))
      .map((child) => build(child, next));
    return { node, children };
  };
  return build(root, new Set());
}

/** Validated / total over every sub-task (cancelled ones are left out). */
export function flowProgress(nodes: IssueFlowNode[], rootIssueId: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const node of nodes) {
    if (node.id === rootIssueId || node.status === "cancelled") continue;
    total += 1;
    if (node.status === "done") done += 1;
  }
  return { done, total };
}

/** Unfinished tasks that other tasks of the tree are waiting on, with how many. */
export function blockingCounts(nodes: IssueFlowNode[]): Map<string, number> {
  const status = new Map(nodes.map((node) => [node.id, node.status]));
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.status === "done" || node.status === "cancelled") continue;
    for (const blocker of node.blockedBy) {
      const blockerStatus = status.get(blocker.id);
      if (!blockerStatus || blockerStatus === "done" || blockerStatus === "cancelled") continue;
      counts.set(blocker.id, (counts.get(blocker.id) ?? 0) + 1);
    }
  }
  return counts;
}

export type FlowPersonRole = "working" | "assigned" | "confirms" | IssueFlowContributorRole;

export interface FlowPerson extends IssueFlowPrincipal {
  role: FlowPersonRole;
  /** Set when a run is executing for this person right now. */
  live: boolean;
}

export const flowPersonRoleLabel: Record<FlowPersonRole, string> = {
  working: "Working now",
  assigned: "Assigned",
  confirms: "Must confirm",
  author: "Author",
  reviewer: "Reviewer",
  approver: "Approver",
};

function principalKey(principal: IssueFlowPrincipal) {
  return principal.type === "agent" ? `agent:${principal.agentId}` : `user:${principal.userId}`;
}

function assigneeOf(node: IssueFlowNode): IssueFlowPrincipal | null {
  if (node.assigneeAgentId) return { type: "agent", agentId: node.assigneeAgentId, userId: null };
  if (node.assigneeUserId) return { type: "user", agentId: null, userId: node.assigneeUserId };
  return null;
}

/**
 * The people shown on a node: who works on it now, who has to confirm for it
 * to move on, and — once validated — who produced, reviewed and approved it.
 */
export function flowNodePeople(node: IssueFlowNode, liveAgentIds: readonly string[]): FlowPerson[] {
  const people: FlowPerson[] = [];
  const seen = new Set<string>();
  const add = (principal: IssueFlowPrincipal | null, role: FlowPersonRole, live = false) => {
    if (!principal) return;
    const key = `${role}:${principalKey(principal)}`;
    if (seen.has(key)) return;
    seen.add(key);
    people.push({ ...principal, role, live });
  };

  for (const agentId of liveAgentIds) add({ type: "agent", agentId, userId: null }, "working", true);

  if (node.status === "done") {
    for (const contributor of node.contributors) add(contributor, contributor.role);
    return people;
  }
  if (node.status === "cancelled") return people;

  const assignee = assigneeOf(node);
  const liveKeys = new Set(liveAgentIds.map((agentId) => `agent:${agentId}`));
  // A pending question without an addressee waits on the board: it is shown
  // as a user principal with no user id.
  for (const confirmation of node.pendingConfirmations) {
    add(confirmation.addressee ?? { type: "user", agentId: null, userId: null }, "confirms");
  }
  if (node.status === "in_review") {
    if (node.executionState?.currentParticipant) add(node.executionState.currentParticipant, "confirms");
    else if (node.pendingConfirmations.length === 0) add(assignee, "confirms");
    return people;
  }
  if (assignee && !liveKeys.has(principalKey(assignee))) {
    add(assignee, node.status === "in_progress" ? "working" : "assigned");
  }
  return people;
}
