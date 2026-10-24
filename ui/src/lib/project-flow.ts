import type {
  ProjectFlowPrincipal,
  ProjectFlowRoleRef,
  ProjectFlowStage,
  ProjectFlowStep,
  ProjectFlowStepState,
} from "@paperclipai/shared";

/** Base hue for each step state, taken from the shared task status tokens. */
export const flowStepStateVar: Record<ProjectFlowStepState, string> = {
  done: "--status-task-done",
  active: "--status-task-in_progress",
  waiting: "--status-task-in_review",
  blocked: "--status-task-blocked",
  not_started: "--status-task-backlog",
  cancelled: "--status-task-cancelled",
};

export const flowStepStateLabel: Record<ProjectFlowStepState, string> = {
  done: "Validated",
  active: "In progress",
  waiting: "Waiting for confirmation",
  blocked: "Blocked",
  not_started: "Not started",
  cancelled: "Cancelled",
};

export type FlowPersonRole = "working" | "confirms" | "author" | "verifier";

export const flowPersonRoleLabel: Record<FlowPersonRole, string> = {
  working: "Working now",
  confirms: "Must confirm",
  author: "Author",
  verifier: "Verifier",
};

/** A person on a node: a known agent or user, or a free label from the stage config. */
export interface FlowPerson {
  role: FlowPersonRole;
  agentId: string | null;
  userId: string | null;
  label: string | null;
  /** Set when a run is executing for this agent on the stage task right now. */
  live: boolean;
}

function fromRole(ref: ProjectFlowRoleRef | null, role: FlowPersonRole): FlowPerson | null {
  return ref ? { role, agentId: ref.agentId, userId: ref.userId, label: ref.label, live: false } : null;
}

function fromPrincipal(principal: ProjectFlowPrincipal, role: FlowPersonRole, live = false): FlowPerson {
  return {
    role,
    agentId: principal.type === "agent" ? principal.agentId : null,
    userId: principal.type === "user" ? principal.userId : null,
    label: null,
    live,
  };
}

function personKey(person: FlowPerson) {
  return `${person.role}:${person.agentId ?? ""}:${person.userId ?? ""}:${person.label ?? ""}`;
}

/**
 * The people shown under a step. While the step is under way: who works on it
 * now and who must confirm. Always: the stage author and verifier from the
 * method, so a validated step still says who produced and checked it.
 */
export function flowStepPeople(
  stage: ProjectFlowStage,
  step: ProjectFlowStep,
  liveAgentIds: readonly string[],
): FlowPerson[] {
  const people: FlowPerson[] = [];
  const seen = new Set<string>();
  const add = (person: FlowPerson | null) => {
    if (!person || seen.has(personKey(person))) return;
    seen.add(personKey(person));
    people.push(person);
  };
  const underWay = step.state === "active" || step.state === "waiting" || step.state === "blocked";
  if (underWay) {
    for (const agentId of liveAgentIds) add(fromPrincipal({ type: "agent", agentId, userId: null }, "working", true));
    const issue = step.issue;
    if (issue && liveAgentIds.length === 0 && issue.status === "in_progress" && issue.assigneeAgentId) {
      add(fromPrincipal({ type: "agent", agentId: issue.assigneeAgentId, userId: null }, "working"));
    }
    for (const principal of step.waitingOn) add(fromPrincipal(principal, "confirms"));
  }
  add(fromRole(stage.author, "author"));
  add(fromRole(stage.verifier, "verifier"));
  return people;
}

