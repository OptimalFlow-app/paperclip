// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueFlowNode, IssueFlowTreeResponse } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TaskFlowPanel } from "./TaskFlowPanel";

const mocks = vi.hoisted(() => ({
  flowTree: vi.fn(),
  liveRunsForCompany: vi.fn(),
  listAgents: vi.fn(),
  listUserDirectory: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));
vi.mock("@/api/issues", () => ({ issuesApi: { flowTree: mocks.flowTree } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: mocks.liveRunsForCompany } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.listAgents } }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: mocks.listUserDirectory } }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function node(overrides: Partial<IssueFlowNode> & Pick<IssueFlowNode, "id" | "identifier" | "title">): IssueFlowNode {
  return {
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

const tree: IssueFlowTreeResponse = {
  rootIssueId: "root",
  truncated: false,
  caps: { maxDepth: 8, maxNodes: 200 },
  nodes: [
    node({ id: "root", identifier: "OPT-1", title: "Mission", parentId: null, depth: 0, status: "in_progress" }),
    node({
      id: "s1",
      identifier: "OPT-2",
      title: "Stage 1",
      status: "done",
      contributors: [
        { type: "agent", agentId: "writer", userId: null, role: "author" },
        { type: "agent", agentId: "cto", userId: null, role: "reviewer" },
      ],
      stages: [{
        id: "stage",
        type: "review",
        participants: [{ type: "agent", agentId: "cto", userId: null }],
        status: "completed",
        roundsUsed: 2,
        maxRounds: 3,
        decisions: [],
      }],
    }),
    node({
      id: "s2",
      identifier: "OPT-3",
      title: "Stage 2",
      status: "in_progress",
      assigneeAgentId: "writer",
      blockedBy: [{ id: "s1", identifier: "OPT-2" }],
    }),
  ],
};

describe("TaskFlowPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.flowTree.mockResolvedValue(tree);
    mocks.liveRunsForCompany.mockResolvedValue([
      { id: "run", status: "running", agentId: "writer", agentName: "Writer", issueId: "s2" },
    ]);
    mocks.listAgents.mockResolvedValue([
      { id: "writer", name: "Writer", title: "Deck writer" },
      { id: "cto", name: "CTO", title: "Chief technology officer" },
    ]);
    mocks.listUserDirectory.mockResolvedValue({ users: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the ordered tree with states, loops, people and the live pulse", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <TooltipProvider>
            <TaskFlowPanel issue={{ id: "root", companyId: "company" }} />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    for (let attempt = 0; attempt < 20 && !container.querySelector('[data-testid="task-flow-panel"]'); attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }

    const cards = [...container.querySelectorAll<HTMLElement>("[data-flow-state]")];
    expect(cards.map((card) => card.querySelector("a")?.textContent)).toEqual(["Mission", "Stage 1", "Stage 2"]);
    expect(cards.map((card) => card.dataset.flowState)).toEqual(["active", "validated", "active"]);
    expect(cards[0]!.querySelector("a")?.getAttribute("href")).toBe("/issues/OPT-1");
    expect(cards[1]!.querySelector('[aria-label="Review loop: 2 of 3 rounds used"]')?.textContent).toBe("2/3");
    expect(cards[1]!.textContent).toContain("WriterAuthor");
    expect(cards[1]!.textContent).toContain("CTOReviewer");
    expect(cards[2]!.classList.contains("flow-node-live")).toBe(true);
    expect(cards[2]!.textContent).toContain("WriterWorking now");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("1");
  });
});
