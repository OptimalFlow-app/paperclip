// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectFlowIssue, ProjectFlowResponse, ProjectFlowStep } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectFlowView } from "./ProjectFlowView";

const mocks = vi.hoisted(() => ({
  flow: vi.fn(),
  liveRunsForCompany: vi.fn(),
  listAgents: vi.fn(),
  listUserDirectory: vi.fn(),
  listLabels: vi.fn(),
  listIssues: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));
vi.mock("@/api/projects", () => ({ projectsApi: { flow: mocks.flow } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: mocks.liveRunsForCompany } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.listAgents } }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: mocks.listUserDirectory } }));
vi.mock("@/api/issues", () => ({ issuesApi: { listLabels: mocks.listLabels, list: mocks.listIssues } }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function issue(overrides: Partial<ProjectFlowIssue> & Pick<ProjectFlowIssue, "id" | "identifier">): ProjectFlowIssue {
  return {
    title: overrides.identifier ?? "Task",
    status: "todo",
    assigneeAgentId: null,
    assigneeUserId: null,
    hasReview: false,
    roundsUsed: 0,
    maxRounds: 3,
    decisions: [],
    waitingOn: [],
    ...overrides,
  };
}

function step(stageId: string, state: ProjectFlowStep["state"], stepIssue: ProjectFlowIssue | null = null): ProjectFlowStep {
  return { stageId, state, issue: stepIssue, issueSource: stepIssue ? "stage" : null, waitingOn: stepIssue?.waitingOn ?? [] };
}

const flow: ProjectFlowResponse = {
  projectId: "project",
  pipelines: [{
    id: "deck",
    key: "deck",
    name: "Deck",
    description: null,
    stages: [
      { id: "brief", key: "brief", name: "Brief", kind: "working", position: 0, author: null, verifier: null, maxReviewRounds: null },
      {
        id: "storyline",
        key: "storyline",
        name: "Storyline",
        kind: "working",
        position: 1,
        author: { agentId: "writer", userId: null, label: null },
        verifier: { agentId: "critic", userId: null, label: null },
        maxReviewRounds: 3,
      },
      { id: "build", key: "build", name: "Build", kind: "working", position: 2, author: null, verifier: null, maxReviewRounds: null },
      {
        id: "final",
        key: "final",
        name: "Final review",
        kind: "review",
        position: 3,
        author: null,
        verifier: { agentId: null, userId: null, label: "Alexis" },
        maxReviewRounds: null,
      },
    ],
    cases: [{
      id: "case",
      caseKey: "deck-bpi",
      title: "Deck BPI",
      currentStageId: "storyline",
      terminalKind: null,
      updatedAt: "2026-10-24T00:00:00.000Z",
      originIssue: { id: "mission", identifier: "OPT-43", title: "Deck mission" },
      steps: [
        step("brief", "done"),
        step("storyline", "waiting", issue({
          id: "story",
          identifier: "OPT-47",
          status: "in_review",
          assigneeAgentId: "writer",
          hasReview: true,
          roundsUsed: 2,
          waitingOn: [{ type: "agent", agentId: "critic", userId: null }],
        })),
        step("build", "not_started", issue({ id: "build-task", identifier: "OPT-48" })),
        step("final", "not_started"),
      ],
      progress: { done: 1, total: 4 },
    }],
  }],
};

describe("ProjectFlowView", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.flow.mockResolvedValue(flow);
    mocks.liveRunsForCompany.mockResolvedValue([
      { id: "run", status: "running", agentId: "builder", agentName: "Builder", issueId: "build-task" },
    ]);
    mocks.listAgents.mockResolvedValue([
      { id: "writer", name: "Writer", title: "Storyliner" },
      { id: "critic", name: "Critic", title: "Deck critic" },
      { id: "builder", name: "Builder", title: "Fabricant" },
    ]);
    mocks.listUserDirectory.mockResolvedValue({ users: [] });
    mocks.listLabels.mockResolvedValue([]);
    mocks.listIssues.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders one row of stage nodes per deliverable with states, loops, people and the live pulse", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <TooltipProvider>
            <ProjectFlowView projectId="project" companyId="company" />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    for (let attempt = 0; attempt < 20 && !container.querySelector('[data-testid="project-flow"]'); attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }

    expect(mocks.flow).toHaveBeenCalledWith("project");
    const row = container.querySelector<HTMLElement>('[data-testid="project-flow-case"]')!;
    expect(row.textContent).toContain("Deck BPI");
    expect(row.querySelector('a[href="/issues/OPT-43"]')).not.toBeNull();
    expect(row.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("1");

    const cells = [...row.querySelectorAll<HTMLElement>("[data-flow-state]")];
    // A running agent lights up a stage that was not started yet.
    expect(cells.map((cell) => cell.dataset.flowState)).toEqual(["done", "waiting", "active", "not_started"]);
    expect(cells[1]!.querySelector('a[href="/issues/OPT-47"]')).not.toBeNull();
    expect(cells[1]!.querySelector('[aria-label="Review loop: 2 of 3 rounds used"]')?.textContent).toBe("2/3");
    expect(cells[1]!.textContent).toContain("Must confirmCritic");
    expect(cells[1]!.textContent).toContain("AuthorWriter");
    expect(cells[1]!.textContent).toContain("VerifierCritic");
    expect(cells[2]!.querySelector(".flow-node-live")).not.toBeNull();
    expect(cells[2]!.textContent).toContain("Working nowBuilder");
    expect(cells[3]!.textContent).toMatch(/Verifier.*Alexis/);
  });

  it("filters deliverables by state and keeps the filter per project", async () => {
    window.localStorage.clear();
    const notStarted = {
      ...flow.pipelines[0]!.cases[0]!,
      id: "case-2",
      caseKey: "deck-ademe",
      title: "Deck ADEME",
      originIssue: null,
      steps: flow.pipelines[0]!.stages.map((stage) => step(stage.id, "not_started")),
      progress: { done: 0, total: 4 },
    };
    mocks.flow.mockResolvedValue({
      ...flow,
      pipelines: [{ ...flow.pipelines[0]!, cases: [...flow.pipelines[0]!.cases, notStarted] }],
    });
    const render = async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      await act(async () => {
        root.render(
          <QueryClientProvider client={client}>
            <TooltipProvider>
              <ProjectFlowView projectId="project" companyId="company" />
            </TooltipProvider>
          </QueryClientProvider>,
        );
      });
      for (let attempt = 0; attempt < 20 && !container.querySelector('[data-testid="project-flow"]'); attempt += 1) {
        await act(async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        });
      }
    };
    const titles = () => [...container.querySelectorAll('[data-testid="project-flow-case"]')].map((row) => row.querySelector("span")?.textContent);
    const filterButton = (state: string, index = 0) =>
      container.querySelectorAll<HTMLButtonElement>(`[data-flow-filter="${state}"] button`)[index]!;

    await render();
    expect(titles()).toEqual(["Deck BPI", "Deck ADEME"]);
    expect(filterButton("not_started").textContent).toContain("1");

    await act(async () => filterButton("not_started").click());
    expect(titles()).toEqual(["Deck BPI"]);
    expect(container.textContent).toContain("1 of 2 deliverables");

    // "only" keeps a single state; nothing is blocked here.
    await act(async () => filterButton("blocked", 1).click());
    expect(titles()).toEqual([]);
    expect(container.textContent).toContain("No deliverable matches the filter.");

    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(titles()).toEqual([]);

    await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Show all")!.click());
    expect(titles()).toEqual(["Deck BPI", "Deck ADEME"]);
    expect(window.localStorage.getItem("paperclip:project-flow:hidden-states:project")).toBeNull();
  });

  it("links a deliverable title to its post in the calendar when one of its tasks is a publication", async () => {
    mocks.listLabels.mockResolvedValue([{ id: "pub-label", name: "publication" }]);
    mocks.listIssues.mockResolvedValue([{ id: "build-task", status: "todo" }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <TooltipProvider>
            <ProjectFlowView projectId="project" companyId="company" />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    const titleLink = () => [...container.querySelectorAll("a")].find((a) => a.textContent === "Deck BPI");
    for (let attempt = 0; attempt < 20 && !titleLink(); attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
    expect(mocks.listIssues).toHaveBeenCalledWith("company", { labelId: "pub-label", limit: 500 });
    expect(titleLink()?.getAttribute("href")).toBe("/calendar?post=build-task");
  });

  it("explains how to start when the project has no pipeline", async () => {
    mocks.flow.mockResolvedValue({ projectId: "project", pipelines: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ProjectFlowView projectId="project" companyId="company" />
        </QueryClientProvider>,
      );
    });
    for (let attempt = 0; attempt < 20 && !container.textContent?.includes("no pipeline"); attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
    expect(container.textContent).toContain("This project has no pipeline yet.");
  });
});
