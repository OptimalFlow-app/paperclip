import { describe, expect, it } from "vitest";
import type { IssueFlowNode } from "@paperclipai/shared";
import {
  blockingCounts,
  buildFlowTreeItems,
  flowNodePeople,
  flowNodeState,
  flowProgress,
} from "./issue-flow-tree";

function node(overrides: Partial<IssueFlowNode> & Pick<IssueFlowNode, "id">): IssueFlowNode {
  return {
    identifier: overrides.id.toUpperCase(),
    title: overrides.id,
    status: "todo",
    parentId: "root",
    depth: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    blockedBy: [],
    executionState: null,
    stages: [],
    pendingConfirmations: [],
    contributors: [],
    ...overrides,
  };
}

describe("flowNodeState", () => {
  it("maps statuses to the five flow states", () => {
    expect(flowNodeState({ status: "done" }, false)).toBe("validated");
    expect(flowNodeState({ status: "in_progress" }, false)).toBe("active");
    expect(flowNodeState({ status: "in_review" }, true)).toBe("waiting");
    expect(flowNodeState({ status: "blocked" }, true)).toBe("blocked");
    expect(flowNodeState({ status: "todo" }, false)).toBe("not_started");
    expect(flowNodeState({ status: "backlog" }, false)).toBe("not_started");
    expect(flowNodeState({ status: "cancelled" }, false)).toBe("cancelled");
  });

  it("treats a not-started task with a live run as active", () => {
    expect(flowNodeState({ status: "todo" }, true)).toBe("active");
  });
});

describe("buildFlowTreeItems", () => {
  it("nests children and orders siblings along the blocker chain", () => {
    const nodes = [
      node({ id: "root", parentId: null, depth: 0 }),
      node({ id: "b", createdAt: "2026-01-01T00:00:00.000Z", blockedBy: [{ id: "a", identifier: "A" }] }),
      node({ id: "a", createdAt: "2026-01-02T00:00:00.000Z" }),
      node({ id: "c", createdAt: "2026-01-03T00:00:00.000Z" }),
      node({ id: "a1", parentId: "a", depth: 2 }),
    ];
    const tree = buildFlowTreeItems(nodes, "root")!;
    expect(tree.children.map((child) => child.node.id)).toEqual(["a", "b", "c"]);
    expect(tree.children[0]!.children.map((child) => child.node.id)).toEqual(["a1"]);
  });

  it("returns null when the root is missing", () => {
    expect(buildFlowTreeItems([node({ id: "a" })], "root")).toBeNull();
  });
});

describe("flowProgress and blockingCounts", () => {
  it("counts validated sub-tasks and the unfinished tasks holding others up", () => {
    const nodes = [
      node({ id: "root", parentId: null, status: "in_progress" }),
      node({ id: "a", status: "done" }),
      node({ id: "b", status: "in_review" }),
      node({ id: "c", status: "todo", blockedBy: [{ id: "a", identifier: "A" }, { id: "b", identifier: "B" }] }),
      node({ id: "d", status: "cancelled" }),
    ];
    expect(flowProgress(nodes, "root")).toEqual({ done: 1, total: 3 });
    expect([...blockingCounts(nodes)]).toEqual([["b", 1]]);
  });
});

describe("flowNodePeople", () => {
  it("shows live agents and the assignee working on an active task", () => {
    const people = flowNodePeople(node({ id: "a", status: "in_progress", assigneeAgentId: "dev" }), ["dev"]);
    expect(people).toEqual([{ type: "agent", agentId: "dev", userId: null, role: "working", live: true }]);
  });

  it("shows the current stage participant as the one who must confirm", () => {
    const people = flowNodePeople(
      node({
        id: "a",
        status: "in_review",
        assigneeAgentId: "cto",
        executionState: {
          status: "pending",
          currentStageId: "s",
          currentStageType: "review",
          currentParticipant: { type: "user", agentId: null, userId: "alexis" },
          returnAssignee: { type: "agent", agentId: "dev", userId: null },
        },
      }),
      [],
    );
    expect(people).toEqual([{ type: "user", agentId: null, userId: "alexis", role: "confirms", live: false }]);
  });

  it("falls back to the assignee for a review without an execution policy", () => {
    const people = flowNodePeople(node({ id: "a", status: "in_review", assigneeUserId: "steven" }), []);
    expect(people).toEqual([{ type: "user", agentId: null, userId: "steven", role: "confirms", live: false }]);
  });

  it("shows the board when a confirmation request has no addressee", () => {
    const people = flowNodePeople(
      node({
        id: "a",
        status: "in_review",
        assigneeAgentId: "lead",
        pendingConfirmations: [{ id: "i", kind: "request_confirmation", addressee: null }],
      }),
      [],
    );
    expect(people).toEqual([{ type: "user", agentId: null, userId: null, role: "confirms", live: false }]);
  });

  it("lists contributors with their role once the task is validated", () => {
    const people = flowNodePeople(
      node({
        id: "a",
        status: "done",
        contributors: [
          { type: "agent", agentId: "dev", userId: null, role: "author" },
          { type: "agent", agentId: "cto", userId: null, role: "reviewer" },
        ],
      }),
      [],
    );
    expect(people.map((person) => [person.agentId, person.role])).toEqual([
      ["dev", "author"],
      ["cto", "reviewer"],
    ]);
  });
});
