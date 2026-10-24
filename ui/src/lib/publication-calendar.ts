/**
 * Publication calendar (OPT-32): social posts scheduled on content tasks.
 *
 * A content task opts in with the `publication` label and carries a
 * `publication` document whose body holds one fenced ```json block:
 *
 *   { "version": 1, "posts": [{ "network": "instagram", "scheduledAt": "...",
 *     "text": "...", "images": [{ "attachmentId": "..." }], ... }] }
 *
 * Everything around the block is free markdown for humans. This module parses
 * that block, maps posts to calendar entries, and knows how to hand a post to
 * each network (compose URL, what goes in the clipboard).
 */

export const PUBLICATION_LABEL_NAME = "publication";
export const PUBLICATION_DOCUMENT_KEY = "publication";

export type PublicationStatus = "draft" | "ready" | "published";

export interface PublicationImage {
  attachmentId: string;
  name?: string;
}

export interface PublicationPost {
  network: string;
  account?: string;
  scheduledAt: string;
  durationMinutes?: number;
  status?: PublicationStatus;
  text: string;
  images?: PublicationImage[];
  publishedAt?: string | null;
  publishedUrl?: string | null;
}

export interface PublicationEntry {
  /** Stable per post: `${issueId}:${index}`. */
  key: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  postIndex: number;
  post: PublicationPost;
  start: Date;
  end: Date;
  status: PublicationStatus;
}

const JSON_BLOCK = /```json[^\n]*\n([\s\S]*?)\n```/;

/**
 * Document bodies go through the server's multiline-text normalisation, which
 * turns `\n` escapes into real line breaks — inside JSON strings too. Re-escape
 * raw control characters found inside string literals before parsing.
 */
function parseLenientJson(source: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (inString) {
      if (char === "\\") {
        out += char + (source[i + 1] ?? "");
        i += 1;
        continue;
      }
      if (char === '"') inString = false;
      else if (char === "\n") {
        out += "\\n";
        continue;
      } else if (char === "\r") {
        out += "\\r";
        continue;
      } else if (char === "\t") {
        out += "\\t";
        continue;
      }
    } else if (char === '"') {
      inString = true;
    }
    out += char;
  }
  return JSON.parse(out);
}

export function parsePublicationDocument(body: string): PublicationPost[] {
  const match = JSON_BLOCK.exec(body);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = parseLenientJson(match[1]!);
  } catch {
    return [];
  }
  const posts = (parsed as { posts?: unknown } | null)?.posts;
  if (!Array.isArray(posts)) return [];
  return posts.filter(
    (post): post is PublicationPost =>
      !!post &&
      typeof post === "object" &&
      typeof (post as PublicationPost).network === "string" &&
      typeof (post as PublicationPost).scheduledAt === "string" &&
      typeof (post as PublicationPost).text === "string" &&
      !Number.isNaN(new Date((post as PublicationPost).scheduledAt).getTime()),
  );
}

/** Rewrites one post inside the document's JSON block, leaving the prose untouched. */
export function updatePublicationPost(
  body: string,
  postIndex: number,
  patch: Partial<PublicationPost>,
): string {
  const match = JSON_BLOCK.exec(body);
  if (!match) throw new Error("No publication JSON block in this document");
  const parsed = parseLenientJson(match[1]!) as { posts: PublicationPost[] };
  const post = parsed.posts?.[postIndex];
  if (!post) throw new Error(`No post #${postIndex} in this document`);
  parsed.posts[postIndex] = { ...post, ...patch };
  const fence = match[0].slice(0, match[0].indexOf("\n") + 1);
  const block = `${fence}${JSON.stringify(parsed, null, 2)}\n\`\`\``;
  return body.slice(0, match.index) + block + body.slice(match.index + match[0].length);
}

export function toPublicationEntries(
  issue: { id: string; identifier: string | null; title: string },
  posts: PublicationPost[],
): PublicationEntry[] {
  return posts.map((post, postIndex) => {
    const start = new Date(post.scheduledAt);
    const minutes = post.durationMinutes && post.durationMinutes > 0 ? post.durationMinutes : 30;
    return {
      key: `${issue.id}:${postIndex}`,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      postIndex,
      post,
      start,
      end: new Date(start.getTime() + minutes * 60_000),
      status: post.status ?? "draft",
    };
  });
}

// ---------------------------------------------------------------------------
// Networks

export interface NetworkMeta {
  label: string;
  /** Event fill / accent, readable with white text. */
  color: string;
  /** Where to land to post; `text` is the caption, prefilled when supported. */
  composeUrl: (text: string) => string;
  /** The network prefills the caption from the URL, so the clipboard can carry the image. */
  prefillsText: boolean;
}

const NETWORKS: Record<string, NetworkMeta> = {
  instagram: {
    label: "Instagram",
    color: "#c13584",
    composeUrl: () => "https://www.instagram.com/",
    prefillsText: false,
  },
  linkedin: {
    label: "LinkedIn",
    color: "#0a66c2",
    composeUrl: (text) => `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text)}`,
    prefillsText: true,
  },
  x: {
    label: "X",
    color: "#111827",
    composeUrl: (text) => `https://x.com/intent/post?text=${encodeURIComponent(text)}`,
    prefillsText: true,
  },
  threads: {
    label: "Threads",
    color: "#374151",
    composeUrl: (text) => `https://www.threads.net/intent/post?text=${encodeURIComponent(text)}`,
    prefillsText: true,
  },
  facebook: {
    label: "Facebook",
    color: "#1877f2",
    composeUrl: () => "https://www.facebook.com/",
    prefillsText: false,
  },
  tiktok: {
    label: "TikTok",
    color: "#0f766e",
    composeUrl: () => "https://www.tiktok.com/upload",
    prefillsText: false,
  },
  youtube: {
    label: "YouTube",
    color: "#dc2626",
    composeUrl: () => "https://studio.youtube.com/",
    prefillsText: false,
  },
};

export function networkMeta(network: string): NetworkMeta {
  const key = network.trim().toLowerCase();
  return (
    NETWORKS[key === "twitter" ? "x" : key] ?? {
      label: network,
      color: "#6b7280",
      composeUrl: () => "about:blank",
      prefillsText: false,
    }
  );
}

export function attachmentContentUrl(attachmentId: string) {
  return `/api/attachments/${encodeURIComponent(attachmentId)}/content`;
}

// ---------------------------------------------------------------------------
// Dates (local time, weeks start on Monday)

export type CalendarView = "week" | "month";

export function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes());
}

export function startOfWeek(date: Date) {
  const day = startOfDay(date);
  return addDays(day, -((day.getDay() + 6) % 7));
}

export function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function dayKey(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Days shown by a view: 7 for a week, whole weeks covering the month otherwise. */
export function visibleDays(anchor: Date, view: CalendarView): Date[] {
  if (view === "week") {
    const start = startOfWeek(anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const start = startOfWeek(first);
  const days: Date[] = [];
  for (let day = start; day <= last || days.length % 7 !== 0; day = addDays(day, 1)) days.push(day);
  return days;
}

export function shiftAnchor(anchor: Date, view: CalendarView, direction: -1 | 1) {
  return view === "week"
    ? addDays(anchor, 7 * direction)
    : new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
}

/** Hour range of the week grid: 07:00–22:00, widened to fit every entry shown. */
export function gridHourRange(entries: PublicationEntry[]): { first: number; last: number } {
  let first = 7;
  let last = 22;
  for (const entry of entries) {
    first = Math.min(first, entry.start.getHours());
    const endHour = entry.end.getHours() + (entry.end.getMinutes() > 0 ? 1 : 0);
    last = Math.max(last, isSameDay(entry.start, entry.end) ? endHour : 24);
  }
  return { first, last };
}
