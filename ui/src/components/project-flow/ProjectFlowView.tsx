import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, RotateCcw, X } from "lucide-react";
import type {
  Agent,
  ProjectFlowCase,
  ProjectFlowIssue,
  ProjectFlowPipeline,
  ProjectFlowStage,
  ProjectFlowStep,
  ProjectFlowStepState,
} from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi, type LiveRunForIssue } from "@/api/heartbeats";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { AgentAvatar } from "@/components/AgentAvatar";
import { deriveInitials } from "@/components/Identity";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatUserLabel } from "@/lib/assignees";
import { buildCompanyUserProfileMap, type CompanyUserProfile } from "@/lib/company-members";
import { createIssueDetailPath } from "@/lib/issueDetailBreadcrumb";
import { isLiveIssueRun } from "@/lib/liveIssueIds";
import { PUBLICATION_LABEL_NAME, publicationCalendarPath } from "@/lib/publication-calendar";
import {
  flowCaseState,
  flowPersonRoleLabel,
  flowStepPeople,
  flowStepStateLabel,
  flowStepStateVar,
  type FlowPerson,
} from "@/lib/project-flow";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

const LEGEND_STATES: ProjectFlowStepState[] = ["done", "active", "waiting", "blocked", "not_started", "cancelled"];
// Case transitions do not emit live events yet; issue activity refreshes the
// view through the "issues" prefix, this catches stage moves in between.
const FLOW_REFETCH_MS = 30_000;

function hiddenStatesStorageKey(projectId: string) {
  return `paperclip:project-flow:hidden-states:${projectId}`;
}

function readHiddenStates(projectId: string): ProjectFlowStepState[] {
  try {
    const raw = window.localStorage.getItem(hiddenStatesStorageKey(projectId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return LEGEND_STATES.filter((state) => parsed.includes(state));
  } catch {
    return [];
  }
}

function writeHiddenStates(projectId: string, states: ProjectFlowStepState[]) {
  try {
    if (states.length === 0) window.localStorage.removeItem(hiddenStatesStorageKey(projectId));
    else window.localStorage.setItem(hiddenStatesStorageKey(projectId), JSON.stringify(states));
  } catch {
    // Ignore localStorage failures.
  }
}

/** Deliverable states hidden from the flow, kept per project in this browser. */
function useHiddenStates(projectId: string) {
  const [state, setState] = useState(() => ({ projectId, hidden: readHiddenStates(projectId) }));
  const hidden = state.projectId === projectId ? state.hidden : readHiddenStates(projectId);
  const setHidden = useCallback((next: ProjectFlowStepState[]) => {
    writeHiddenStates(projectId, next);
    setState({ projectId, hidden: next });
  }, [projectId]);
  return [hidden, setHidden] as const;
}

function FlowFilter({
  counts,
  hidden,
  onChange,
}: {
  counts: Map<ProjectFlowStepState, number>;
  hidden: ProjectFlowStepState[];
  onChange: (hidden: ProjectFlowStepState[]) => void;
}) {
  const toggle = (state: ProjectFlowStepState) =>
    onChange(hidden.includes(state) ? hidden.filter((s) => s !== state) : [...hidden, state]);
  const only = (state: ProjectFlowStepState) => onChange(LEGEND_STATES.filter((s) => s !== state));
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-muted-foreground" role="group" aria-label="Filter deliverables by state">
      {LEGEND_STATES.map((state) => {
        const shown = !hidden.includes(state);
        return (
          <span key={state} className="group inline-flex items-center rounded-full border" data-flow-filter={state}>
            <button
              type="button"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full py-0.5 pl-2 pr-1.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                shown ? "text-foreground" : "line-through opacity-50",
              )}
              aria-pressed={shown}
              title={shown ? "Hide these deliverables" : "Show these deliverables"}
              onClick={() => toggle(state)}
            >
              <span className="status-fill inline-flex size-2.5 rounded-full" style={hue(flowStepStateVar[state])} aria-hidden />
              {flowStepStateLabel[state]}
              <span className="font-mono text-muted-foreground">{counts.get(state) ?? 0}</span>
            </button>
            <button
              type="button"
              className="hidden rounded-full py-0.5 pl-0.5 pr-2 text-muted-foreground hover:text-foreground hover:underline focus-visible:inline focus-visible:outline-none group-hover:inline group-focus-within:inline"
              title={`Show only ${flowStepStateLabel[state].toLowerCase()} deliverables`}
              aria-label={`Show only ${flowStepStateLabel[state]}`}
              onClick={() => only(state)}
            >
              only
            </button>
          </span>
        );
      })}
      {hidden.length > 0 ? (
        <button
          type="button"
          className="px-1.5 py-0.5 text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onChange([])}
        >
          Show all
        </button>
      ) : null}
      <span className="ml-2 inline-flex items-center gap-1">
        <RotateCcw className="size-3" aria-hidden />
        Review rounds used / max
      </span>
    </div>
  );
}

function hue(cssVar: string): CSSProperties {
  return { "--sc": `var(${cssVar})` } as CSSProperties;
}

interface FlowDirectory {
  agents: Map<string, Agent>;
  users: Map<string, CompanyUserProfile>;
}

function personName(person: { agentId: string | null; userId: string | null; label?: string | null }, directory: FlowDirectory) {
  if (person.agentId) return directory.agents.get(person.agentId)?.name ?? "Unknown agent";
  if (person.userId) return directory.users.get(person.userId)?.label ?? formatUserLabel(person.userId) ?? "Unknown user";
  return person.label ?? "Board";
}

function issueLabel(issue: Pick<ProjectFlowIssue, "identifier" | "title">) {
  return issue.identifier ?? issue.title;
}

function PersonChip({ person, directory }: { person: FlowPerson; directory: FlowDirectory }) {
  const name = personName(person, directory);
  const agent = person.agentId ? directory.agents.get(person.agentId) : undefined;
  const role = flowPersonRoleLabel[person.role];
  return (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1 rounded-full py-0.5 pl-0.5 pr-1.5 text-xs",
        person.role === "working" || person.role === "confirms" ? "bg-accent" : "bg-muted/60",
      )}
      title={`${name} — ${role}${agent?.title ? ` · ${agent.title}` : ""}`}
    >
      {person.agentId ? (
        <AgentAvatar agent={agent ?? { id: person.agentId, name }} size={16} pose={person.live ? "working" : "rest"} />
      ) : (
        <Avatar size="xs">
          {person.userId && directory.users.get(person.userId)?.image ? (
            <AvatarImage src={directory.users.get(person.userId)!.image!} alt="" />
          ) : null}
          <AvatarFallback>{deriveInitials(name)}</AvatarFallback>
        </Avatar>
      )}
      <span className="truncate text-foreground">{name}</span>
    </span>
  );
}

function loopVar(issue: ProjectFlowIssue, state: ProjectFlowStepState) {
  if (state === "done") return "--status-task-done";
  if (issue.roundsUsed >= issue.maxRounds) return "--status-task-blocked";
  if (state === "waiting") return "--status-task-in_review";
  return "--status-task-backlog";
}

function ReviewLoop({ issue, state, directory }: { issue: ProjectFlowIssue; state: ProjectFlowStepState; directory: FlowDirectory }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="status-chip inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-xs"
          style={hue(loopVar(issue, state))}
          aria-label={`Review loop: ${issue.roundsUsed} of ${issue.maxRounds} rounds used`}
          tabIndex={0}
        >
          <RotateCcw className="size-3" aria-hidden />
          {issue.roundsUsed}/{issue.maxRounds}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        <div className="flex flex-col gap-1.5">
          <span className="font-medium">
            Review loop — {issue.roundsUsed} of {issue.maxRounds} rounds used
          </span>
          {issue.decisions.length === 0 ? (
            <span className="opacity-80">No decision recorded yet.</span>
          ) : (
            <ol className="flex flex-col gap-1">
              {issue.decisions.map((decision) => (
                <li key={decision.id}>
                  <span className="font-mono opacity-80">{new Date(decision.createdAt).toLocaleString()}</span>{" "}
                  <span className="font-medium">
                    {decision.outcome === "approved" ? "Approved" : "Changes requested"}
                  </span>
                  {" · "}
                  {personName({ agentId: decision.actorAgentId, userId: decision.actorUserId }, directory)}
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

function StepNode({ state, live }: { state: ProjectFlowStepState; live: boolean }) {
  const filled = state === "done" || state === "active" || state === "blocked";
  return (
    <span
      className={cn(
        "status-border relative z-10 inline-flex size-5 shrink-0 items-center justify-center rounded-full border-2 bg-background",
        filled && "status-fill",
        live && "flow-node-live",
      )}
      style={hue(flowStepStateVar[state])}
      aria-hidden
    >
      {state === "done" ? <Check className="size-3 text-background" strokeWidth={3} /> : null}
      {state === "blocked" ? <X className="size-3 text-background" strokeWidth={3} /> : null}
      {state === "waiting" ? <span className="status-fill size-2 rounded-full" /> : null}
    </span>
  );
}

function Connector({ done, hidden }: { done: boolean; hidden: boolean }) {
  return (
    <span
      className={cn("h-0.5 flex-1", hidden ? "invisible" : done ? "status-fill" : "bg-border")}
      style={hue("--status-task-done")}
      aria-hidden
    />
  );
}

interface StepCellProps {
  stage: ProjectFlowStage;
  step: ProjectFlowStep;
  index: number;
  steps: ProjectFlowStep[];
  liveAgentIds: string[];
  directory: FlowDirectory;
}

function StepCell({ stage, step, index, steps, liveAgentIds, directory }: StepCellProps) {
  const live = liveAgentIds.length > 0;
  const state = step.state === "not_started" && live ? "active" : step.state;
  const people = flowStepPeople(stage, { ...step, state }, liveAgentIds);
  const previous = steps[index - 1];
  const issue = step.issue;
  return (
    <div
      className="flex min-w-0 flex-col items-stretch gap-1.5"
      role="listitem"
      data-flow-state={state}
      aria-label={`${stage.name}: ${flowStepStateLabel[state]}`}
    >
      <div className="flex items-center" title={`${stage.name} — ${flowStepStateLabel[state]}`}>
        <Connector done={previous?.state === "done"} hidden={index === 0} />
        <StepNode state={state} live={live} />
        <Connector done={state === "done"} hidden={index === steps.length - 1} />
      </div>
      <div className="flex min-w-0 flex-col items-center gap-1 px-1 text-center">
        {issue ? (
          <span className="flex max-w-full items-center gap-1">
            <Link
              to={createIssueDetailPath(issue.identifier ?? issue.id)}
              className="truncate font-mono text-xs text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={`${issue.identifier ? `${issue.identifier} — ` : ""}${issue.title}`}
            >
              {issueLabel(issue)}
            </Link>
            {issue.hasReview ? <ReviewLoop issue={issue} state={state} directory={directory} /> : null}
          </span>
        ) : null}
        {state !== "done" && state !== "not_started" ? (
          <span className="text-xs text-muted-foreground">{flowStepStateLabel[state]}</span>
        ) : null}
        {people.length > 0 ? (
          <span className="flex max-w-full flex-col items-center gap-0.5">
            {people.map((person) => (
              <span key={`${person.role}:${person.agentId ?? person.userId ?? person.label}`} className="flex min-w-0 max-w-full items-center gap-1">
                <span className="shrink-0 text-xs text-muted-foreground">{flowPersonRoleLabel[person.role]}</span>
                <PersonChip person={person} directory={directory} />
              </span>
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// Fixed column floors keep every row aligned; names truncate rather than
// widening a column, and the section scrolls sideways below the floor.
function gridStyle(stageCount: number): CSSProperties {
  return { gridTemplateColumns: `minmax(10rem, 13rem) repeat(${stageCount}, minmax(7.5rem, 1fr))` };
}

function minWidthStyle(stageCount: number): CSSProperties {
  return { minWidth: `${10 + stageCount * 7.5}rem` };
}

/** The case's task that carries a scheduled post, if any (origin first, then stage tasks). */
function publicationIssueId(flowCase: ProjectFlowCase, publicationIssueIds: Set<string>) {
  const ids = [flowCase.originIssue?.id, ...flowCase.steps.map((step) => step.issue?.id)];
  return ids.find((id): id is string => !!id && publicationIssueIds.has(id)) ?? null;
}

function CaseRow({
  pipeline,
  flowCase,
  liveAgentsByIssueId,
  publicationIssueIds,
  directory,
}: {
  pipeline: ProjectFlowPipeline;
  flowCase: ProjectFlowCase;
  liveAgentsByIssueId: Map<string, string[]>;
  publicationIssueIds: Set<string>;
  directory: FlowDirectory;
}) {
  const percent = flowCase.progress.total > 0 ? Math.round((flowCase.progress.done / flowCase.progress.total) * 100) : 0;
  const origin = flowCase.originIssue;
  const postIssueId = publicationIssueId(flowCase, publicationIssueIds);
  const titleClass = cn("text-sm font-medium", flowCase.terminalKind === "cancelled" && "text-muted-foreground line-through");
  return (
    <div className="grid items-start gap-x-1 border-t py-3" style={gridStyle(pipeline.stages.length)} data-testid="project-flow-case">
      <div className="flex min-w-0 flex-col gap-1 pr-2">
        {postIssueId ? (
          <Link to={publicationCalendarPath(postIssueId)} className={cn(titleClass, "hover:underline")} title="Open the post in the calendar">
            {flowCase.title}
          </Link>
        ) : (
          <span className={titleClass}>{flowCase.title}</span>
        )}
        {origin ? (
          <Link
            to={createIssueDetailPath(origin.identifier ?? origin.id)}
            className="truncate font-mono text-xs text-muted-foreground hover:underline"
            title={origin.title}
          >
            {origin.identifier ?? origin.title}
          </Link>
        ) : null}
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className="h-1 flex-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={flowCase.progress.total}
            aria-valuenow={flowCase.progress.done}
            aria-label={`${flowCase.title}: stages validated`}
          >
            <span className="status-fill block h-full rounded-full" style={{ ...hue("--status-task-done"), width: `${percent}%` }} />
          </span>
          <span className="font-mono">{flowCase.progress.done}/{flowCase.progress.total}</span>
        </span>
      </div>
      <div className="contents" role="list" aria-label={`${flowCase.title} stages`}>
        {pipeline.stages.map((stage, index) => {
          const step = flowCase.steps[index]!;
          return (
            <StepCell
              key={stage.id}
              stage={stage}
              step={step}
              index={index}
              steps={flowCase.steps}
              liveAgentIds={step.issue ? liveAgentsByIssueId.get(step.issue.id) ?? [] : []}
              directory={directory}
            />
          );
        })}
      </div>
    </div>
  );
}

function PipelineFlow({
  pipeline,
  visibleCases,
  liveAgentsByIssueId,
  publicationIssueIds,
  directory,
}: {
  pipeline: ProjectFlowPipeline;
  visibleCases: ProjectFlowCase[];
  liveAgentsByIssueId: Map<string, string[]>;
  publicationIssueIds: Set<string>;
  directory: FlowDirectory;
}) {
  const total = pipeline.cases.length;
  return (
    <section className="flex flex-col gap-2" aria-label={pipeline.name}>
      <div className="flex items-baseline gap-2">
        <h2 className="text-base font-semibold">{pipeline.name}</h2>
        <span className="text-xs text-muted-foreground">
          {visibleCases.length < total ? `${visibleCases.length} of ` : ""}
          {total} {total === 1 ? "deliverable" : "deliverables"}
        </span>
      </div>
      {pipeline.description ? <p className="text-sm text-muted-foreground">{pipeline.description}</p> : null}
      <div className="overflow-x-auto">
        <div style={minWidthStyle(pipeline.stages.length)}>
          <div className="grid items-end gap-x-1 pb-2" style={gridStyle(pipeline.stages.length)}>
            <span />
            {pipeline.stages.map((stage) => (
              <span key={stage.id} className="px-1 text-center text-xs font-medium" title={stage.key}>
                {stage.name}
              </span>
            ))}
          </div>
          {total === 0 ? (
            <p className="border-t py-4 text-sm text-muted-foreground">No deliverable in this flow yet.</p>
          ) : visibleCases.length === 0 ? (
            <p className="border-t py-4 text-sm text-muted-foreground">No deliverable matches the filter.</p>
          ) : (
            visibleCases.map((flowCase) => (
              <CaseRow
                key={flowCase.id}
                pipeline={pipeline}
                flowCase={flowCase}
                liveAgentsByIssueId={liveAgentsByIssueId}
                publicationIssueIds={publicationIssueIds}
                directory={directory}
              />
            ))
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Project flow: for each pipeline of the project, one row of nodes per
 * deliverable, one node per stage of the method — including stages that have
 * no task yet — coloured by state, with the stage task, its review loop and
 * the people on it.
 */
export function ProjectFlowView({ projectId, companyId }: { projectId: string; companyId: string }) {
  const flowQuery = useQuery({
    queryKey: queryKeys.issues.projectFlow(companyId, projectId),
    queryFn: () => projectsApi.flow(projectId),
    refetchInterval: FLOW_REFETCH_MS,
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    refetchInterval: false,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const { data: members } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
  });

  // Same queries as the publication calendar, so its cache is shared.
  const { data: labels } = useQuery({
    queryKey: queryKeys.issues.labels(companyId),
    queryFn: () => issuesApi.listLabels(companyId),
  });
  const publicationLabelId = labels?.find((label) => label.name.trim().toLowerCase() === PUBLICATION_LABEL_NAME)?.id ?? null;
  const { data: publicationIssues } = useQuery({
    queryKey: [...queryKeys.issues.list(companyId), "publication-calendar", publicationLabelId],
    queryFn: () => issuesApi.list(companyId, { labelId: publicationLabelId!, limit: 500 }),
    enabled: !!publicationLabelId,
  });
  const publicationIssueIds = useMemo(
    () => new Set((publicationIssues ?? []).filter((issue) => issue.status !== "cancelled").map((issue) => issue.id)),
    [publicationIssues],
  );

  const directory = useMemo<FlowDirectory>(() => ({
    agents: new Map((agents ?? []).map((agent) => [agent.id, agent])),
    users: buildCompanyUserProfileMap(members?.users),
  }), [agents, members?.users]);

  const pipelines = flowQuery.data?.pipelines;
  const liveAgentsByIssueId = useMemo(() => {
    const statusById = new Map<string, string>();
    for (const pipeline of pipelines ?? []) {
      for (const flowCase of pipeline.cases) {
        for (const step of flowCase.steps) if (step.issue) statusById.set(step.issue.id, step.issue.status);
      }
    }
    const byIssue = new Map<string, string[]>();
    for (const run of (liveRuns ?? []) as LiveRunForIssue[]) {
      if (!run.issueId || !statusById.has(run.issueId)) continue;
      if (!isLiveIssueRun(run, statusById.get(run.issueId))) continue;
      const list = byIssue.get(run.issueId) ?? [];
      if (!list.includes(run.agentId)) list.push(run.agentId);
      byIssue.set(run.issueId, list);
    }
    return byIssue;
  }, [liveRuns, pipelines]);

  const [hiddenStates, setHiddenStates] = useHiddenStates(projectId);
  const caseStates = useMemo(() => {
    const byCase = new Map<string, ProjectFlowStepState>();
    for (const pipeline of pipelines ?? []) {
      for (const flowCase of pipeline.cases) byCase.set(flowCase.id, flowCaseState(flowCase, liveAgentsByIssueId));
    }
    return byCase;
  }, [pipelines, liveAgentsByIssueId]);
  const stateCounts = useMemo(() => {
    const counts = new Map<ProjectFlowStepState, number>();
    for (const state of caseStates.values()) counts.set(state, (counts.get(state) ?? 0) + 1);
    return counts;
  }, [caseStates]);

  if (flowQuery.isLoading) {
    return <p className="py-6 text-sm text-muted-foreground">Loading the project flow…</p>;
  }
  if (flowQuery.isError || !pipelines) {
    return (
      <p className="py-6 text-sm text-destructive" role="alert">
        Could not load the project flow. Reload the page to try again.
      </p>
    );
  }
  if (pipelines.length === 0) {
    return (
      <p className="py-6 text-sm text-muted-foreground">
        This project has no pipeline yet. Create one for the project to follow its deliverables stage by stage.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6" data-testid="project-flow">
      <FlowFilter counts={stateCounts} hidden={hiddenStates} onChange={setHiddenStates} />
      {pipelines.map((pipeline) => (
        <PipelineFlow
          key={pipeline.id}
          pipeline={pipeline}
          visibleCases={pipeline.cases.filter((flowCase) => !hiddenStates.includes(caseStates.get(flowCase.id) ?? "not_started"))}
          liveAgentsByIssueId={liveAgentsByIssueId}
          publicationIssueIds={publicationIssueIds}
          directory={directory}
        />
      ))}
    </div>
  );
}
