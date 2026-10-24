import { useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Hourglass, Link2, RotateCcw } from "lucide-react";
import type { Agent, IssueFlowDecision, IssueFlowNode, IssueFlowStage } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi, type LiveRunForIssue } from "@/api/heartbeats";
import { issuesApi } from "@/api/issues";
import { AgentAvatar } from "@/components/AgentAvatar";
import { deriveInitials } from "@/components/Identity";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatUserLabel } from "@/lib/assignees";
import { buildCompanyUserProfileMap, type CompanyUserProfile } from "@/lib/company-members";
import {
  blockingCounts,
  buildFlowTreeItems,
  flowNodePeople,
  flowNodeState,
  flowNodeStateLabel,
  flowNodeStateVar,
  flowPersonRoleLabel,
  flowProgress,
  type FlowNodeState,
  type FlowPerson,
  type FlowTreeItem,
} from "@/lib/issue-flow-tree";
import {
  createIssueDetailPath,
  rememberIssueDetailLocationState,
} from "@/lib/issueDetailBreadcrumb";
import { isLiveIssueRun } from "@/lib/liveIssueIds";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

const LEGEND_STATES: FlowNodeState[] = ["validated", "active", "waiting", "blocked", "not_started"];

function hue(cssVar: string): CSSProperties {
  return { "--sc": `var(${cssVar})` } as CSSProperties;
}

interface FlowDirectory {
  agents: Map<string, Agent>;
  users: Map<string, CompanyUserProfile>;
}

function principalName(
  principal: { type: "agent" | "user"; agentId: string | null; userId: string | null },
  directory: FlowDirectory,
) {
  if (principal.type === "agent") {
    return directory.agents.get(principal.agentId ?? "")?.name ?? "Unknown agent";
  }
  if (!principal.userId) return "Board";
  return directory.users.get(principal.userId)?.label
    ?? formatUserLabel(principal.userId)
    ?? "Unknown user";
}

function StateDot({ state, live }: { state: FlowNodeState; live: boolean }) {
  return (
    <span className="relative inline-flex size-2.5 shrink-0" style={hue(flowNodeStateVar[state])} aria-hidden>
      {live ? <span className="status-fill tc-live-ping absolute inline-flex size-full rounded-full opacity-75" /> : null}
      <span className="status-fill relative inline-flex size-2.5 rounded-full" />
    </span>
  );
}

function UserAvatar({ name, image }: { name: string; image: string | null }) {
  return (
    <Avatar size="xs">
      {image ? <AvatarImage src={image} alt="" /> : null}
      <AvatarFallback>{deriveInitials(name)}</AvatarFallback>
    </Avatar>
  );
}

function PersonChip({ person, directory }: { person: FlowPerson; directory: FlowDirectory }) {
  const name = principalName(person, directory);
  const agent = person.type === "agent" ? directory.agents.get(person.agentId ?? "") : undefined;
  const role = flowPersonRoleLabel[person.role];
  const title = agent?.title ? `${role} · ${agent.title}` : role;
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1 rounded-full bg-muted/60 py-0.5 pl-0.5 pr-2 text-xs"
      title={`${name} — ${title}`}
    >
      {person.type === "agent" ? (
        <AgentAvatar agent={agent ?? { id: person.agentId ?? undefined, name }} size={16} pose={person.live ? "working" : "rest"} />
      ) : (
        <UserAvatar name={name} image={directory.users.get(person.userId ?? "")?.image ?? null} />
      )}
      <span className="truncate font-medium text-foreground">{name}</span>
      <span className="shrink-0 text-muted-foreground">{role}</span>
    </span>
  );
}

function decisionLabel(decision: IssueFlowDecision) {
  return decision.outcome === "approved" ? "Approved" : "Changes requested";
}

function stageLoopVar(stage: IssueFlowStage) {
  if (stage.status === "completed") return "--status-task-done";
  if (stage.roundsUsed >= stage.maxRounds) return "--status-task-blocked";
  if (stage.status === "active") return "--status-task-in_review";
  return "--status-task-backlog";
}

function StageLoop({ stage, directory }: { stage: IssueFlowStage; directory: FlowDirectory }) {
  const kind = stage.type === "approval" ? "Approval" : "Review";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="status-chip inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-xs"
          style={hue(stageLoopVar(stage))}
          aria-label={`${kind} loop: ${stage.roundsUsed} of ${stage.maxRounds} rounds used`}
          tabIndex={0}
        >
          <RotateCcw className="size-3" aria-hidden />
          {stage.roundsUsed}/{stage.maxRounds}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        <div className="flex flex-col gap-1.5">
          <span className="font-medium">
            {kind} loop — {stage.roundsUsed} of {stage.maxRounds} rounds used
          </span>
          {stage.decisions.length === 0 ? (
            <span className="opacity-80">No decision recorded yet.</span>
          ) : (
            <ol className="flex flex-col gap-1">
              {stage.decisions.map((decision) => (
                <li key={decision.id}>
                  <span className="font-mono opacity-80">{new Date(decision.createdAt).toLocaleString()}</span>{" "}
                  <span className="font-medium">{decisionLabel(decision)}</span>
                  {" · "}
                  {principalName(
                    decision.actorAgentId
                      ? { type: "agent", agentId: decision.actorAgentId, userId: null }
                      : { type: "user", agentId: null, userId: decision.actorUserId },
                    directory,
                  )}
                  {decision.bodyExcerpt ? <span className="block opacity-80">{decision.bodyExcerpt}</span> : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

interface FlowRenderContext {
  directory: FlowDirectory;
  liveAgentsByIssueId: Map<string, string[]>;
  blocking: Map<string, number>;
  statusById: Map<string, IssueFlowNode["status"]>;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  issueLinkState?: unknown;
}

function FlowNodeCard({ item, isRoot, context }: { item: FlowTreeItem; isRoot: boolean; context: FlowRenderContext }) {
  const { node, children } = item;
  const liveAgentIds = context.liveAgentsByIssueId.get(node.id) ?? [];
  const live = liveAgentIds.length > 0;
  const state = flowNodeState(node, live);
  const people = flowNodePeople(node, liveAgentIds);
  const pathId = node.identifier ?? node.id;
  const holdsUp = context.blocking.get(node.id) ?? 0;
  const waitingOn = node.blockedBy.filter((blocker) => {
    const status = context.statusById.get(blocker.id);
    return status !== "done" && status !== "cancelled";
  });
  const collapsed = context.collapsed.has(node.id);

  return (
    <div className="flex min-w-0 items-start gap-1">
      {children.length > 0 ? (
        <button
          type="button"
          className="mt-2 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => context.toggle(node.id)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${pathId}` : `Collapse ${pathId}`}
        >
          {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
      ) : (
        <span className="size-5 shrink-0" aria-hidden />
      )}
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-1.5 rounded-md border bg-card px-2.5 py-2",
          live && "flow-node-live",
          holdsUp > 0 && "border-dashed",
        )}
        style={{ ...hue(flowNodeStateVar[state]), borderColor: "var(--sc)" }}
        data-flow-state={state}
      >
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-1 inline-flex">
            <StateDot state={state} live={live} />
          </span>
          <Link
            to={createIssueDetailPath(pathId)}
            state={context.issueLinkState}
            onClickCapture={() => rememberIssueDetailLocationState(pathId, context.issueLinkState)}
            className={cn(
              "line-clamp-2 min-w-0 flex-1 text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isRoot && "font-medium",
              state === "cancelled" && "text-muted-foreground line-through",
            )}
            title={`${node.identifier ? `${node.identifier} — ` : ""}${node.title}`}
          >
            {node.title}
          </Link>
          {node.stages.map((stage) => (
            <StageLoop key={stage.id} stage={stage} directory={context.directory} />
          ))}
          {node.identifier ? (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{node.identifier}</span>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="status-chip inline-flex items-center rounded-full border px-1.5 py-0.5">
            {flowNodeStateLabel[state]}
          </span>
          {people.map((person) => (
            <PersonChip
              key={`${person.role}:${person.type}:${person.agentId ?? person.userId}`}
              person={person}
              directory={context.directory}
            />
          ))}
          {holdsUp > 0 ? (
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <Hourglass className="size-3" aria-hidden />
              Holds up {holdsUp} {holdsUp === 1 ? "task" : "tasks"}
            </span>
          ) : null}
          {waitingOn.length > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Link2 className="size-3" aria-hidden />
              Waits on {waitingOn.map((blocker) => blocker.identifier ?? "a task").join(", ")}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FlowBranch({ item, isRoot, context }: { item: FlowTreeItem; isRoot: boolean; context: FlowRenderContext }) {
  const collapsed = context.collapsed.has(item.node.id);
  return (
    <li role="treeitem" aria-expanded={item.children.length > 0 ? !collapsed : undefined} className="flex flex-col gap-1.5">
      <FlowNodeCard item={item} isRoot={isRoot} context={context} />
      {item.children.length > 0 && !collapsed ? (
        <ul role="group" className="ml-2.5 flex flex-col gap-1.5 border-l pl-2.5">
          {item.children.map((child) => (
            <FlowBranch key={child.node.id} item={child} isRoot={false} context={context} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Task flow view: the task, its nested sub-tasks in hand-off order, each
 * coloured by state, with its review/approval loop and the people on it.
 * Refreshes through the live issue and run events like the rest of the page.
 */
export function TaskFlowPanel({
  issue,
  issueLinkState,
}: {
  issue: { id: string; companyId: string };
  issueLinkState?: unknown;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const flowQuery = useQuery({
    queryKey: queryKeys.issues.flowTree(issue.companyId, issue.id),
    queryFn: () => issuesApi.flowTree(issue.id),
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(issue.companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(issue.companyId),
    refetchInterval: false,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(issue.companyId),
    queryFn: () => agentsApi.list(issue.companyId),
  });
  const { data: members } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(issue.companyId),
    queryFn: () => accessApi.listUserDirectory(issue.companyId),
  });

  const directory = useMemo<FlowDirectory>(() => ({
    agents: new Map((agents ?? []).map((agent) => [agent.id, agent])),
    users: buildCompanyUserProfileMap(members?.users),
  }), [agents, members?.users]);

  const nodes = flowQuery.data?.nodes;
  const tree = useMemo(
    () => (nodes && flowQuery.data ? buildFlowTreeItems(nodes, flowQuery.data.rootIssueId) : null),
    [nodes, flowQuery.data],
  );
  const statusById = useMemo(() => new Map((nodes ?? []).map((node) => [node.id, node.status])), [nodes]);
  const liveAgentsByIssueId = useMemo(() => {
    const byIssue = new Map<string, string[]>();
    for (const run of (liveRuns ?? []) as LiveRunForIssue[]) {
      if (!run.issueId || !statusById.has(run.issueId)) continue;
      if (!isLiveIssueRun(run, statusById.get(run.issueId))) continue;
      const list = byIssue.get(run.issueId) ?? [];
      if (!list.includes(run.agentId)) list.push(run.agentId);
      byIssue.set(run.issueId, list);
    }
    return byIssue;
  }, [liveRuns, statusById]);
  const blocking = useMemo(() => blockingCounts(nodes ?? []), [nodes]);
  const progress = useMemo(
    () => (nodes && flowQuery.data ? flowProgress(nodes, flowQuery.data.rootIssueId) : { done: 0, total: 0 }),
    [nodes, flowQuery.data],
  );

  if (flowQuery.isLoading) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Loading the task flow…</p>;
  }
  if (flowQuery.isError || !tree) {
    return (
      <p className="py-6 text-center text-sm text-destructive" role="alert">
        Could not load the task flow. Reload the page to try again.
      </p>
    );
  }

  const context: FlowRenderContext = {
    directory,
    liveAgentsByIssueId,
    blocking,
    statusById,
    collapsed,
    toggle: (id) => setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    }),
    issueLinkState,
  };
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="flex flex-col gap-3" data-testid="task-flow-panel">
      {progress.total > 0 ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Stages validated</span>
            <span className="font-mono">{progress.done}/{progress.total}</span>
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            aria-label="Stages validated"
          >
            <div className="status-fill h-full rounded-full" style={{ ...hue("--status-task-done"), width: `${percent}%` }} />
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
        {LEGEND_STATES.map((state) => (
          <span key={state} className="inline-flex items-center gap-1.5">
            <StateDot state={state} live={false} />
            {flowNodeStateLabel[state]}
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <RotateCcw className="size-3" aria-hidden />
          Review rounds used / max
        </span>
      </div>
      <ul role="tree" aria-label="Task flow" className="flex flex-col gap-1.5">
        <FlowBranch item={tree} isRoot context={context} />
      </ul>
      {flowQuery.data?.truncated ? (
        <p className="text-xs text-muted-foreground">
          Showing the first {flowQuery.data.caps.maxNodes} tasks, up to {flowQuery.data.caps.maxDepth} levels deep.
        </p>
      ) : null}
    </div>
  );
}
