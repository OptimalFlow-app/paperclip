/**
 * Publication calendar (OPT-32): a Google-Calendar-style week/month view of
 * the social posts scheduled on content tasks, with a one-click hand-off per
 * post — caption and image (or Reel video) to the clipboard / downloads,
 * network opened in a new tab. Data contract lives in `lib/publication-calendar.ts`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Send,
  Undo2,
} from "lucide-react";
import { issuesApi } from "../api/issues";
import { ApiError } from "../api/client";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useOptionalToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { copyImageToClipboard, copyTextToClipboard } from "../lib/clipboard";
import { Link, useSearchParams } from "@/lib/router";
import { cn, issueUrl } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  CALENDAR_POST_PARAM,
  PUBLICATION_DOCUMENT_KEY,
  PUBLICATION_LABEL_NAME,
  attachmentContentUrl,
  dayKey,
  entryToOpen,
  gridHourRange,
  isSameDay,
  networkMeta,
  parsePublicationDocument,
  publicationReel,
  shiftAnchor,
  startOfDay,
  toPublicationEntries,
  updatePublicationPost,
  visibleDays,
  type CalendarView,
  type PublicationEntry,
  type PublicationImage,
} from "../lib/publication-calendar";

const HOUR_PX = 48;
const MIN_EVENT_PX = 38;
const SNAP_MINUTES = 15;
const DRAG_MIME = "application/x-publication-entry";

type Reschedule = (entry: PublicationEntry, start: Date) => void;

const STATUS_LABEL: Record<PublicationEntry["status"], string> = {
  draft: "Not validated — provisional slot",
  ready: "Validated — ready to post",
  published: "Published",
};

export function PublicationCalendar() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [view, setView] = useState<CalendarView>("week");
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const now = useNow();
  const reschedulePost = useReschedulePost();
  const reschedule: Reschedule = (entry, start) => {
    if (start.getTime() === entry.start.getTime()) return;
    reschedulePost.mutate({ entry, start });
  };

  useEffect(() => {
    setBreadcrumbs([{ label: "Calendar" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? "";
  const labelsQuery = useQuery({
    queryKey: queryKeys.issues.labels(companyId),
    queryFn: () => issuesApi.listLabels(companyId),
    enabled: !!selectedCompanyId,
  });
  const label = labelsQuery.data?.find((l) => l.name.trim().toLowerCase() === PUBLICATION_LABEL_NAME);

  const issuesQuery = useQuery({
    queryKey: [...queryKeys.issues.list(companyId), "publication-calendar", label?.id ?? null],
    queryFn: () => issuesApi.list(companyId, { labelId: label!.id, limit: 500 }),
    enabled: !!selectedCompanyId && !!label,
  });
  const issues = useMemo(
    () => (issuesQuery.data ?? []).filter((issue) => issue.status !== "cancelled"),
    [issuesQuery.data],
  );

  const documentQueries = useQueries({
    queries: issues.map((issue) => ({
      queryKey: [...queryKeys.issues.documents(issue.id), PUBLICATION_DOCUMENT_KEY],
      queryFn: async () => {
        try {
          return await issuesApi.getDocument(issue.id, PUBLICATION_DOCUMENT_KEY);
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        }
      },
    })),
  });

  const entries = useMemo(() => {
    const all: PublicationEntry[] = [];
    issues.forEach((issue, index) => {
      const doc = documentQueries[index]?.data;
      if (!doc) return;
      all.push(...toPublicationEntries(issue, parsePublicationDocument(doc.body)));
    });
    return all.sort((a, b) => a.start.getTime() - b.start.getTime());
  }, [issues, documentQueries]);

  // A link from elsewhere (the project flow) names a task: once its post is
  // loaded, land on its day and open it, once per link so closing stays closed.
  const [searchParams] = useSearchParams();
  const focusIssueId = searchParams.get(CALENDAR_POST_PARAM);
  const focusIndex = focusIssueId ? issues.findIndex((issue) => issue.id === focusIssueId) : -1;
  const focusReady = !!focusIssueId && issuesQuery.isSuccess && (focusIndex < 0 || documentQueries[focusIndex]?.isPending === false);
  const focusedIssueId = useRef<string | null>(null);
  useEffect(() => {
    if (!focusIssueId || !focusReady || focusedIssueId.current === focusIssueId) return;
    focusedIssueId.current = focusIssueId;
    const entry = entryToOpen(entries, focusIssueId);
    if (!entry) return;
    setAnchor(startOfDay(entry.start));
    setSelectedKey(entry.key);
  }, [focusIssueId, focusReady, entries]);

  const days = useMemo(() => visibleDays(anchor, view), [anchor, view]);
  const selected = entries.find((entry) => entry.key === selectedKey) ?? null;
  const nextUp = entries.find((entry) => entry.status !== "published" && entry.end.getTime() >= now.getTime() - 86_400_000);

  if (!selectedCompanyId) {
    return <EmptyState icon={CalendarDays} message="Select an organization to view its publication calendar." />;
  }
  if (labelsQuery.isLoading || issuesQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const loadError = labelsQuery.error ?? issuesQuery.error ?? documentQueries.find((q) => q.error)?.error;

  return (
    <div className="flex flex-col gap-4">
      {loadError ? <p className="text-sm text-destructive">{loadError.message}</p> : null}

      {nextUp ? <NextUpBanner entry={nextUp} now={now} onOpen={() => setSelectedKey(nextUp.key)} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setAnchor(startOfDay(new Date()))}>
          Today
        </Button>
        <div className="flex items-center">
          <Button size="icon-sm" variant="ghost" aria-label="Previous" onClick={() => setAnchor((a) => shiftAnchor(a, view, -1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Next" onClick={() => setAnchor((a) => shiftAnchor(a, view, 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <h2 className="text-base font-semibold">{rangeTitle(days, view, anchor)}</h2>
        <div className="ml-auto flex rounded-md border border-border p-0.5" role="group" aria-label="Calendar view">
          {(["week", "month"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              onClick={() => setView(option)}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium capitalize",
                view === option ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {!label || entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No scheduled posts yet. A content task appears here once it has the <code>publication</code> label and a{" "}
          <code>publication</code> document listing its posts.
        </p>
      ) : null}

      {view === "week" ? (
        <WeekGrid days={days} entries={entries} now={now} onSelect={setSelectedKey} onReschedule={reschedule} />
      ) : (
        <MonthGrid
          days={days}
          month={anchor.getMonth()}
          entries={entries}
          now={now}
          onSelect={setSelectedKey}
          onReschedule={reschedule}
        />
      )}

      <Legend entries={entries} />

      <Sheet open={!!selected} onOpenChange={(open) => (open ? null : setSelectedKey(null))}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          {selected ? (
            <PostDetail entry={selected} now={now} onReschedule={reschedule} pending={reschedulePost.isPending} />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** Moves one post to a new slot; the status (validated or not) is kept. */
function useReschedulePost() {
  const toast = useOptionalToastActions();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ entry, start }: { entry: PublicationEntry; start: Date }) => {
      const doc = await issuesApi.getDocument(entry.issueId, PUBLICATION_DOCUMENT_KEY);
      const body = updatePublicationPost(doc.body, entry.postIndex, { scheduledAt: start.toISOString() });
      return issuesApi.upsertDocument(entry.issueId, PUBLICATION_DOCUMENT_KEY, {
        title: doc.title,
        format: doc.format,
        body,
        baseRevisionId: doc.latestRevisionId,
        changeSummary: `${networkMeta(entry.post.network).label} post moved to ${start.toISOString()} from the calendar`,
      });
    },
    onSuccess: (_doc, { entry, start }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(entry.issueId) });
      toast?.pushToast({
        title: `Moved to ${start.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`,
        tone: "success",
      });
    },
    onError: (error) => toast?.pushToast({ title: `Couldn't move the post: ${(error as Error).message}`, tone: "warn" }),
  });
}

function startDrag(event: React.DragEvent<HTMLElement>, entry: PublicationEntry) {
  const grabOffsetY = event.clientY - event.currentTarget.getBoundingClientRect().top;
  event.dataTransfer.setData(DRAG_MIME, JSON.stringify({ key: entry.key, grabOffsetY }));
  event.dataTransfer.effectAllowed = "move";
}

function readDrag(event: React.DragEvent<HTMLElement>, entries: PublicationEntry[]) {
  try {
    const { key, grabOffsetY } = JSON.parse(event.dataTransfer.getData(DRAG_MIME)) as { key: string; grabOffsetY: number };
    const entry = entries.find((e) => e.key === key);
    return entry ? { entry, grabOffsetY: grabOffsetY || 0 } : null;
  } catch {
    return null;
  }
}

function allowDrop(event: React.DragEvent<HTMLElement>) {
  if (!event.dataTransfer.types.includes(DRAG_MIME)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
}

function toLocalInputValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dayKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function rangeTitle(days: Date[], view: CalendarView, anchor: Date) {
  if (view === "month") return anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const first = days[0]!;
  const last = days[days.length - 1]!;
  const sameMonth = first.getMonth() === last.getMonth();
  const start = first.toLocaleDateString(undefined, sameMonth ? { day: "numeric" } : { day: "numeric", month: "short" });
  const end = last.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return `${start} – ${end}`;
}

function formatTime(date: Date) {
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function isOverdue(entry: PublicationEntry, now: Date) {
  return entry.status !== "published" && entry.end.getTime() < now.getTime();
}

function entryTitle(entry: PublicationEntry) {
  return entry.issueTitle.replace(/\s*\([^)]*\d{1,2}\/\d{1,2}\)\s*$/, "");
}

// ---------------------------------------------------------------------------
// Grids

function WeekGrid({
  days,
  entries,
  now,
  onSelect,
  onReschedule,
}: {
  days: Date[];
  entries: PublicationEntry[];
  now: Date;
  onSelect: (key: string) => void;
  onReschedule: Reschedule;
}) {
  const weekEntries = entries.filter((entry) => days.some((day) => isSameDay(day, entry.start)));
  const { first, last } = gridHourRange(weekEntries);
  const hours = Array.from({ length: last - first }, (_, i) => first + i);
  const height = hours.length * HOUR_PX;

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <div className="min-w-[760px]">
        <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b border-border">
          <div />
          {days.map((day) => {
            const today = isSameDay(day, now);
            return (
              <div key={dayKey(day)} className="border-l border-border px-2 py-2 text-center">
                <div className="text-[11px] font-medium uppercase text-muted-foreground">
                  {day.toLocaleDateString(undefined, { weekday: "short" })}
                </div>
                <div
                  className={cn(
                    "mx-auto mt-0.5 flex h-8 w-8 items-center justify-center rounded-full text-lg",
                    today && "bg-primary text-primary-foreground",
                  )}
                >
                  {day.getDate()}
                </div>
              </div>
            );
          })}
        </div>
        <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))]" style={{ height }}>
          <div className="relative">
            {hours.map((hour, i) =>
              i === 0 ? null : (
                <div
                  key={hour}
                  className="absolute right-2 -translate-y-1/2 text-[10px] text-muted-foreground"
                  style={{ top: i * HOUR_PX }}
                >
                  {String(hour).padStart(2, "0")}:00
                </div>
              ),
            )}
          </div>
          {days.map((day) => {
            const dayEntries = layoutLanes(weekEntries.filter((entry) => isSameDay(entry.start, day)));
            return (
              <div
                key={dayKey(day)}
                className={cn("relative border-l border-border", isSameDay(day, now) && "bg-primary/[0.03]")}
                onDragOver={allowDrop}
                onDrop={(event) => {
                  const dragged = readDrag(event, entries);
                  if (!dragged) return;
                  event.preventDefault();
                  const y = event.clientY - event.currentTarget.getBoundingClientRect().top - dragged.grabOffsetY;
                  const raw = first * 60 + (y / HOUR_PX) * 60;
                  const minutes = Math.min(Math.max(Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES, 0), 24 * 60 - SNAP_MINUTES);
                  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60);
                  onReschedule(dragged.entry, start);
                }}
              >
                {hours.map((hour, i) => (
                  <div key={hour} className="absolute inset-x-0 border-t border-border/60" style={{ top: i * HOUR_PX }} />
                ))}
                {dayEntries.map(({ entry, lane, lanes }) => {
                  const startMinutes = (entry.start.getHours() - first) * 60 + entry.start.getMinutes();
                  const durationMinutes = (entry.end.getTime() - entry.start.getTime()) / 60_000;
                  return (
                    <EventBlock
                      key={entry.key}
                      entry={entry}
                      now={now}
                      onSelect={onSelect}
                      style={{
                        top: (startMinutes / 60) * HOUR_PX,
                        height: Math.max((durationMinutes / 60) * HOUR_PX, MIN_EVENT_PX),
                        left: `calc(${(lane / lanes) * 100}% + 2px)`,
                        width: `calc(${100 / lanes}% - 4px)`,
                      }}
                    />
                  );
                })}
                {isSameDay(day, now) && now.getHours() >= first && now.getHours() < last ? (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
                    style={{ top: (((now.getHours() - first) * 60 + now.getMinutes()) / 60) * HOUR_PX }}
                    aria-hidden="true"
                  >
                    <div className="-ml-1 h-2 w-2 rounded-full bg-red-500" />
                    <div className="h-px flex-1 bg-red-500" />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Side-by-side lanes for overlapping entries of one day. */
function layoutLanes(entries: PublicationEntry[]) {
  const placed: { entry: PublicationEntry; lane: number; lanes: number }[] = [];
  let cluster: { entry: PublicationEntry; lane: number; end: number }[] = [];
  let clusterEnd = 0;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((item) => item.lane + 1));
    for (const { entry, lane } of cluster) placed.push({ entry, lane, lanes });
    cluster = [];
  };
  for (const entry of entries) {
    const start = entry.start.getTime();
    // Blocks are drawn at least MIN_EVENT_PX tall, so overlap on the drawn size.
    const end = Math.max(entry.end.getTime(), start + (MIN_EVENT_PX / HOUR_PX) * 3_600_000);
    if (cluster.length && start >= clusterEnd) flush();
    const busy = new Set(cluster.filter((item) => item.end > start).map((item) => item.lane));
    let lane = 0;
    while (busy.has(lane)) lane += 1;
    cluster.push({ entry, lane, end });
    clusterEnd = Math.max(clusterEnd, end);
  }
  if (cluster.length) flush();
  return placed;
}

function EventBlock({
  entry,
  now,
  onSelect,
  style,
}: {
  entry: PublicationEntry;
  now: Date;
  onSelect: (key: string) => void;
  style: React.CSSProperties;
}) {
  const meta = networkMeta(entry.post.network);
  const overdue = isOverdue(entry, now);
  return (
    <button
      type="button"
      draggable={entry.status !== "published"}
      onDragStart={(event) => startDrag(event, entry)}
      onClick={() => onSelect(entry.key)}
      title={`${meta.label} · ${entryTitle(entry)}`}
      className={cn(
        "absolute z-[1] overflow-hidden rounded-md px-1.5 py-0.5 text-left text-[11px] leading-tight shadow-sm transition hover:z-20 hover:shadow-md focus-visible:outline-2",
        entry.status === "draft" && "border border-dashed",
        entry.status === "published" && "opacity-55",
        overdue && "ring-2 ring-red-500",
      )}
      style={{
        ...style,
        ...eventColors(entry, meta.color),
      }}
    >
      <div className="flex items-center gap-1 font-semibold">
        {entry.status === "published" ? <Check className="h-3 w-3 shrink-0" /> : null}
        <span className="truncate">
          {formatTime(entry.start)} · {meta.label}
        </span>
      </div>
      <div className="truncate opacity-90">{entryTitle(entry)}</div>
    </button>
  );
}

function eventColors(entry: PublicationEntry, color: string): React.CSSProperties {
  if (entry.status === "draft") {
    return {
      color,
      borderColor: color,
      background: `repeating-linear-gradient(135deg, ${color}1f, ${color}1f 6px, ${color}10 6px, ${color}10 12px)`,
    };
  }
  return { background: color, color: "#fff" };
}

function MonthGrid({
  days,
  month,
  entries,
  now,
  onSelect,
  onReschedule,
}: {
  days: Date[];
  month: number;
  entries: PublicationEntry[];
  now: Date;
  onSelect: (key: string) => void;
  onReschedule: Reschedule;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <div className="grid min-w-[760px] grid-cols-7">
        {days.slice(0, 7).map((day) => (
          <div key={`h-${dayKey(day)}`} className="border-b border-border py-1.5 text-center text-[11px] font-medium uppercase text-muted-foreground">
            {day.toLocaleDateString(undefined, { weekday: "short" })}
          </div>
        ))}
        {days.map((day, index) => {
          const dayEntries = entries.filter((entry) => isSameDay(entry.start, day));
          const today = isSameDay(day, now);
          return (
            <div
              key={dayKey(day)}
              onDragOver={allowDrop}
              onDrop={(event) => {
                const dragged = readDrag(event, entries);
                if (!dragged) return;
                event.preventDefault();
                const { start } = dragged.entry;
                onReschedule(
                  dragged.entry,
                  new Date(day.getFullYear(), day.getMonth(), day.getDate(), start.getHours(), start.getMinutes()),
                );
              }}
              className={cn(
                "min-h-28 border-border p-1",
                index % 7 !== 0 && "border-l",
                index >= 7 && "border-t",
                day.getMonth() !== month && "bg-muted/30",
              )}
            >
              <div
                className={cn(
                  "mb-1 flex h-6 w-6 items-center justify-center rounded-full text-xs",
                  today && "bg-primary text-primary-foreground",
                  day.getMonth() !== month && !today && "text-muted-foreground",
                )}
              >
                {day.getDate()}
              </div>
              <div className="flex flex-col gap-0.5">
                {dayEntries.map((entry) => {
                  const meta = networkMeta(entry.post.network);
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      draggable={entry.status !== "published"}
                      onDragStart={(event) => startDrag(event, entry)}
                      onClick={() => onSelect(entry.key)}
                      className={cn(
                        "truncate rounded px-1.5 py-0.5 text-left text-[11px]",
                        entry.status === "draft" && "border border-dashed",
                        entry.status === "published" && "opacity-55",
                        isOverdue(entry, now) && "ring-2 ring-red-500",
                      )}
                      style={eventColors(entry, meta.color)}
                      title={`${meta.label} · ${entryTitle(entry)}`}
                    >
                      {formatTime(entry.start)} {meta.label} · {entryTitle(entry)}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Legend({ entries }: { entries: PublicationEntry[] }) {
  const networks = [...new Set(entries.map((entry) => entry.post.network.toLowerCase()))];
  if (networks.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {networks.map((network) => {
        const meta = networkMeta(network);
        return (
          <span key={network} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: meta.color }} />
            {meta.label}
          </span>
        );
      })}
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-4 rounded-sm border border-dashed border-muted-foreground" />
        not validated yet
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-4 rounded-sm ring-2 ring-red-500" />
        slot passed, not published
      </span>
    </div>
  );
}

function NextUpBanner({ entry, now, onOpen }: { entry: PublicationEntry; now: Date; onOpen: () => void }) {
  const meta = networkMeta(entry.post.network);
  const overdue = isOverdue(entry, now);
  const when = isSameDay(entry.start, now)
    ? `today at ${formatTime(entry.start)}`
    : entry.start.toLocaleString(undefined, { weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <div className={cn("flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2", overdue ? "border-red-500/50 bg-red-500/5" : "border-border bg-muted/30")}>
      <span className="h-8 w-1 rounded-full" style={{ background: meta.color }} />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">{overdue ? "Overdue" : "Next to post"} · {meta.label} · {when}</div>
        <div className="truncate text-sm font-medium">{entryTitle(entry)}</div>
      </div>
      {entry.status === "draft" ? <span className="text-xs text-muted-foreground">not validated yet</span> : null}
      <Button size="sm" onClick={onOpen}>
        Open
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Post detail + hand-off

function PostDetail({
  entry,
  now,
  onReschedule,
  pending,
}: {
  entry: PublicationEntry;
  now: Date;
  onReschedule: Reschedule;
  pending: boolean;
}) {
  const toast = useOptionalToastActions();
  const queryClient = useQueryClient();
  const meta = networkMeta(entry.post.network);
  const reel = publicationReel(entry.post);
  const images = reel ? [] : (entry.post.images ?? []);
  const firstImage = images[0];
  const text = entry.post.text;
  const overdue = isOverdue(entry, now);

  const notify = (title: string, tone: "success" | "warn" = "success") => toast?.pushToast({ title, tone });

  const handOff = async () => {
    // Text-prefilling networks get the image on the clipboard (paste it in the
    // composer); the others get the caption, and the image is downloaded.
    // A Reel's video always goes to downloads.
    const copyImageFirst = meta.prefillsText && !!firstImage;
    try {
      if (copyImageFirst) await copyImage(firstImage);
      else await copyTextToClipboard(text);
      notify(copyImageFirst ? "Image copied — paste it into the post" : "Text copied — paste it into the post");
    } catch {
      notify("Couldn't write to the clipboard — use the copy buttons below.", "warn");
    }
    if (firstImage && !meta.prefillsText) downloadAttachment(firstImage, "image.png");
    if (reel) downloadAttachment(reel.video, "reel.mp4");
    window.open(meta.composeUrl(text), "_blank", "noopener,noreferrer");
  };

  const markPublished = useMutation({
    mutationFn: async (published: boolean) => {
      const doc = await issuesApi.getDocument(entry.issueId, PUBLICATION_DOCUMENT_KEY);
      const body = updatePublicationPost(doc.body, entry.postIndex, {
        status: published ? "published" : "ready",
        publishedAt: published ? new Date().toISOString() : null,
      });
      return issuesApi.upsertDocument(entry.issueId, PUBLICATION_DOCUMENT_KEY, {
        title: doc.title,
        format: doc.format,
        body,
        baseRevisionId: doc.latestRevisionId,
        changeSummary: `${meta.label} post marked as ${published ? "published" : "not published"} from the calendar`,
      });
    },
    onSuccess: (_doc, published) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(entry.issueId) });
      notify(published ? "Marked as published" : "Marked as not published");
    },
    onError: (error) => notify(`Couldn't update the post: ${(error as Error).message}`, "warn"),
  });

  const setValidated = useMutation({
    mutationFn: async (validated: boolean) => {
      const doc = await issuesApi.getDocument(entry.issueId, PUBLICATION_DOCUMENT_KEY);
      const body = updatePublicationPost(doc.body, entry.postIndex, {
        status: validated ? "ready" : "draft",
        // A fresh validation lets the auto-publisher take the post again.
        publishAttemptedAt: null,
        publishError: null,
      });
      return issuesApi.upsertDocument(entry.issueId, PUBLICATION_DOCUMENT_KEY, {
        title: doc.title,
        format: doc.format,
        body,
        baseRevisionId: doc.latestRevisionId,
        changeSummary: `${meta.label} post ${validated ? "validated" : "unvalidated"} from the calendar`,
      });
    },
    onSuccess: (_doc, validated) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(entry.issueId) });
      notify(validated ? "Validated — will go out in its slot" : "Validation removed");
    },
    onError: (error) => notify(`Couldn't update the post: ${(error as Error).message}`, "warn"),
  });

  const openTaskButton = (
    <Button size="lg" variant="outline" asChild>
      <Link to={issueUrl({ id: entry.issueId, identifier: entry.issueIdentifier })}>
        <ExternalLink className="h-4 w-4" />
        Open task {entry.issueIdentifier ?? ""}
      </Link>
    </Button>
  );

  return (
    <>
      <SheetHeader className="gap-1 pr-10">
        <div className="flex items-center gap-2 text-xs font-medium" style={{ color: meta.color }}>
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: meta.color }} />
          {meta.label}
          {reel ? <Badge variant="secondary">Reel</Badge> : null}
          {reel?.trialReel ? <Badge variant="outline">Trial</Badge> : null}
          {entry.post.account ? <span className="font-normal text-muted-foreground">· {entry.post.account}</span> : null}
        </div>
        <SheetTitle className="text-lg leading-snug">{entryTitle(entry)}</SheetTitle>
        <SheetDescription>
          {entry.start.toLocaleString(undefined, {
            weekday: "long",
            day: "numeric",
            month: "long",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </SheetDescription>
        {entry.status !== "published" ? (
          <RescheduleField key={entry.start.getTime()} entry={entry} onReschedule={onReschedule} pending={pending} />
        ) : null}
      </SheetHeader>

      <div className="flex flex-col gap-5 px-4 pb-6">
        <div
          className={cn(
            "rounded-md border px-3 py-2 text-sm",
            entry.status === "draft" && "border-amber-500/50 bg-amber-500/10",
            entry.status === "ready" && (overdue ? "border-red-500/50 bg-red-500/10" : "border-emerald-500/50 bg-emerald-500/10"),
            entry.status === "published" && "border-border bg-muted/40",
          )}
        >
          {entry.status === "ready" && entry.post.publishError
            ? `Auto-post failed: ${entry.post.publishError}. Unvalidate then Validate to retry.`
            : overdue && entry.status === "ready"
              ? "Slot passed — validated, still to post."
              : STATUS_LABEL[entry.status]}
          {entry.status === "published" && entry.post.publishedAt
            ? ` on ${new Date(entry.post.publishedAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
            : null}
          {entry.status === "published" && entry.post.publishedUrl ? (
            <a className="ml-2 underline" href={entry.post.publishedUrl} target="_blank" rel="noreferrer">
              View post
            </a>
          ) : null}
        </div>

        {entry.status !== "published" ? (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-3 gap-2">
              <Button size="lg" onClick={() => void handOff()} style={{ background: meta.color, color: "#fff" }}>
                <Send className="h-4 w-4" />
                Post on {meta.label}
              </Button>
              {openTaskButton}
              <Button
                size="lg"
                variant={entry.status === "ready" ? "outline" : "default"}
                disabled={setValidated.isPending}
                onClick={() => setValidated.mutate(entry.status !== "ready")}
              >
                {entry.status === "ready" ? <Undo2 className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                {entry.status === "ready" ? "Unvalidate" : "Validate"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{handOffHint(meta.label, meta.prefillsText, reel ? "video" : firstImage ? "image" : null)}</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">{openTaskButton}</div>
        )}

        {reel ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium uppercase text-muted-foreground">Video</h3>
            {reel.hasImages ? (
              <p className="rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm">
                This post also lists images: a Reel is a video alone, so the publishing script will refuse it.
              </p>
            ) : null}
            <video
              controls
              preload="metadata"
              src={attachmentContentUrl(reel.video.attachmentId)}
              poster={reel.cover ? attachmentContentUrl(reel.cover.attachmentId) : undefined}
              aria-label={reel.video.name ?? "Reel video"}
              className="max-h-128 w-full rounded-md border border-border bg-black object-contain"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => downloadAttachment(reel.video, "reel.mp4")}>
                <Download className="h-3.5 w-3.5" />
                Download video
              </Button>
              {reel.cover ? (
                <Button size="sm" variant="outline" onClick={() => downloadAttachment(reel.cover!, "cover.png")}>
                  <Download className="h-3.5 w-3.5" />
                  Download cover
                </Button>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {reel.shareToFeed ? "Also shown in the profile grid" : "Reels tab only, not in the profile grid"}
              </span>
            </div>
          </section>
        ) : null}

        {images.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium uppercase text-muted-foreground">Image</h3>
            {images.map((image) => (
              <div key={image.attachmentId} className="flex flex-col gap-2">
                <img
                  src={attachmentContentUrl(image.attachmentId)}
                  alt={image.name ?? "Post image"}
                  className="max-h-96 w-full rounded-md border border-border bg-muted/30 object-contain"
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      copyImage(image).then(
                        () => notify("Image copied"),
                        () => notify("This browser can't copy images — download it instead.", "warn"),
                      )
                    }
                  >
                    <ImageIcon className="h-3.5 w-3.5" />
                    Copy image
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => downloadAttachment(image, "image.png")}>
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </Button>
                </div>
              </div>
            ))}
          </section>
        ) : null}

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase text-muted-foreground">Text · {text.length} characters</h3>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                copyTextToClipboard(text).then(
                  () => notify("Text copied"),
                  () => notify("Couldn't write to the clipboard.", "warn"),
                )
              }
            >
              <Copy className="h-3.5 w-3.5" />
              Copy text
            </Button>
          </div>
          <div className="whitespace-pre-wrap rounded-md border border-border bg-muted/20 p-3 text-sm leading-relaxed">{text}</div>
        </section>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Button
            size="sm"
            variant="outline"
            disabled={markPublished.isPending}
            onClick={() => markPublished.mutate(entry.status !== "published")}
          >
            {entry.status === "published" ? <Undo2 className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
            {entry.status === "published" ? "Mark as not published" : "Mark as published"}
          </Button>
        </div>
      </div>
    </>
  );
}

function RescheduleField({ entry, onReschedule, pending }: { entry: PublicationEntry; onReschedule: Reschedule; pending: boolean }) {
  const [value, setValue] = useState(() => toLocalInputValue(entry.start));
  const next = new Date(value);
  const changed = !Number.isNaN(next.getTime()) && next.getTime() !== entry.start.getTime();
  return (
    <form
      className="mt-1 flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed) onReschedule(entry, next);
      }}
    >
      <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
      <input
        type="datetime-local"
        aria-label="Post date and time"
        value={value}
        step={60 * SNAP_MINUTES}
        onChange={(event) => setValue(event.target.value)}
        className="h-8 rounded-md border border-border bg-background px-2 text-sm"
      />
      <Button type="submit" size="sm" variant={changed ? "default" : "outline"} disabled={!changed || pending}>
        Change date
      </Button>
    </form>
  );
}

function handOffHint(label: string, prefillsText: boolean, media: "image" | "video" | null) {
  if (media === "video") {
    return `Copies the text, downloads the video and opens ${label}: create a Reel, drop in the video, paste the text (⌘V).`;
  }
  const hasImage = media === "image";
  if (prefillsText) {
    return hasImage
      ? `Opens ${label} with the text already filled in, and copies the image: paste it into the post (⌘V).`
      : `Opens ${label} with the text already filled in.`;
  }
  return hasImage
    ? `Copies the text, downloads the image and opens ${label}: create a post, drop in the image, paste the text (⌘V).`
    : `Copies the text and opens ${label}: create a post and paste it (⌘V).`;
}

function downloadAttachment(media: PublicationImage, fallbackName: string) {
  const link = document.createElement("a");
  link.href = attachmentContentUrl(media.attachmentId);
  link.download = media.name ?? fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function copyImage(image: PublicationImage) {
  return copyImageToClipboard(
    fetch(attachmentContentUrl(image.attachmentId), { credentials: "same-origin" })
      .then((res) => {
        if (!res.ok) throw new Error(`Image request failed: ${res.status}`);
        return res.blob();
      })
      .then((data) => (data.type === "image/png" ? data : toPng(data))),
  );
}

async function toPng(data: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(data);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("PNG conversion failed"))), "image/png"),
  );
}
