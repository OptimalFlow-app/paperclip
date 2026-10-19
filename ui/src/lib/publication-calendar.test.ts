import { describe, expect, it } from "vitest";
import {
  gridHourRange,
  networkMeta,
  parsePublicationDocument,
  toPublicationEntries,
  updatePublicationPost,
  visibleDays,
  dayKey,
} from "./publication-calendar";

const post = {
  network: "instagram",
  scheduledAt: "2026-10-20T12:15:00+02:00",
  durationMinutes: 15,
  status: "ready" as const,
  text: "Caption with $& and $1 in it",
  images: [{ attachmentId: "att-1", name: "a.png" }],
};

const body = `Intro prose.\n\n\`\`\`json\n${JSON.stringify({ version: 1, posts: [post] }, null, 2)}\n\`\`\`\n\nTrailing notes.\n`;

describe("parsePublicationDocument", () => {
  it("reads the posts from the fenced json block", () => {
    const posts = parsePublicationDocument(body);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.network).toBe("instagram");
  });

  it("tolerates escapes turned into raw line breaks by the server", () => {
    const normalised = body.replace(/\\n/g, "\n");
    const multiline = { ...post, text: "Line one\n\nLine \"two\"" };
    const raw = "```json\n" + JSON.stringify({ posts: [multiline] }).replace(/\\n/g, "\n") + "\n```";
    expect(parsePublicationDocument(normalised)).toHaveLength(1);
    expect(parsePublicationDocument(raw)[0]!.text).toBe(multiline.text);
  });

  it("ignores documents without a valid block and malformed posts", () => {
    expect(parsePublicationDocument("no block here")).toEqual([]);
    expect(parsePublicationDocument("```json\n{not json\n```")).toEqual([]);
    const mixed = "```json\n" + JSON.stringify({ posts: [post, { network: "x" }, { ...post, scheduledAt: "soon" }] }) + "\n```";
    expect(parsePublicationDocument(mixed)).toHaveLength(1);
  });
});

describe("updatePublicationPost", () => {
  it("patches one post and keeps the surrounding prose", () => {
    const next = updatePublicationPost(body, 0, { status: "published", publishedAt: "2026-10-20T10:20:00.000Z" });
    expect(next.startsWith("Intro prose.")).toBe(true);
    expect(next.endsWith("Trailing notes.\n")).toBe(true);
    const [updated] = parsePublicationDocument(next);
    expect(updated!.status).toBe("published");
    expect(updated!.text).toBe(post.text);
  });

  it("refuses an unknown post index", () => {
    expect(() => updatePublicationPost(body, 3, { status: "published" })).toThrow();
  });
});

describe("toPublicationEntries", () => {
  it("derives start/end and defaults the status to draft", () => {
    const [entry] = toPublicationEntries(
      { id: "issue-1", identifier: "OPT-5", title: "C2" },
      [{ ...post, status: undefined, durationMinutes: undefined }],
    );
    expect(entry!.key).toBe("issue-1:0");
    expect(entry!.status).toBe("draft");
    expect(entry!.end.getTime() - entry!.start.getTime()).toBe(30 * 60_000);
  });
});

describe("networkMeta", () => {
  it("prefills LinkedIn text through the share URL", () => {
    const meta = networkMeta("LinkedIn");
    expect(meta.prefillsText).toBe(true);
    expect(meta.composeUrl("a b&c")).toBe("https://www.linkedin.com/feed/?shareActive=true&text=a%20b%26c");
  });

  it("falls back for unknown networks", () => {
    expect(networkMeta("mastodon").label).toBe("mastodon");
    expect(networkMeta("twitter").label).toBe("X");
  });
});

describe("visibleDays", () => {
  it("starts weeks on Monday", () => {
    const days = visibleDays(new Date(2026, 9, 22), "week");
    expect(days.map(dayKey)).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
    ]);
  });

  it("covers the month with whole weeks", () => {
    const days = visibleDays(new Date(2026, 9, 1), "month");
    expect(days.length % 7).toBe(0);
    expect(dayKey(days[0]!)).toBe("2026-09-28");
    expect(dayKey(days[days.length - 1]!)).toBe("2026-11-01");
  });
});

describe("gridHourRange", () => {
  it("widens the default 07–22 range to fit early posts", () => {
    const entries = toPublicationEntries({ id: "i", identifier: null, title: "t" }, [
      { ...post, scheduledAt: new Date(2026, 9, 20, 6, 30).toISOString() },
    ]);
    expect(gridHourRange(entries)).toEqual({ first: 6, last: 22 });
    expect(gridHourRange([])).toEqual({ first: 7, last: 22 });
  });
});
