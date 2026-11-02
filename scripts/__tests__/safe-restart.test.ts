import { describe, expect, it } from "vitest";

import {
  buildRelaunchEnv,
  countLiveRuns,
  DEFAULT_IDLE_TIMEOUT_MS,
  findDestructiveStatements,
  formatOutcomeComment,
  parseArgs,
  parseDuration,
  parsePsEnvironment,
  type RestartOutcome,
} from "../safe-restart.ts";

describe("findDestructiveStatements", () => {
  it("flags DROP, TRUNCATE, DELETE, ALTER COLUMN TYPE and RENAME with their lines", () => {
    const sql = [
      'CREATE TABLE "a" ("id" uuid PRIMARY KEY);',
      "--> statement-breakpoint",
      'ALTER TABLE "issues" DROP COLUMN "legacy";',
      'DROP TABLE IF EXISTS "old_things";',
      'TRUNCATE "cache";',
      'DELETE FROM "events" WHERE "kind" = \'noise\';',
      'ALTER TABLE "runs" ALTER COLUMN "status" SET DATA TYPE text;',
      'ALTER TABLE "runs" ALTER COLUMN "n" TYPE bigint;',
      'ALTER TABLE "runs" RENAME COLUMN "a" TO "b";',
    ].join("\n");

    expect(findDestructiveStatements(sql).map(({ line, kind }) => ({ line, kind }))).toEqual([
      { line: 3, kind: "drop" },
      { line: 4, kind: "drop" },
      { line: 5, kind: "truncate" },
      { line: 6, kind: "delete" },
      { line: 7, kind: "alter_type" },
      { line: 8, kind: "alter_type" },
      { line: 9, kind: "rename" },
    ]);
  });

  it("returns the offending source line", () => {
    const [finding] = findDestructiveStatements('\n  ALTER TABLE "x" DROP COLUMN "y";\n');
    expect(finding).toEqual({ line: 2, kind: "drop", text: 'ALTER TABLE "x" DROP COLUMN "y";' });
  });

  it("ignores additive migrations and harmless DROP DEFAULT / DROP NOT NULL", () => {
    const sql = [
      'CREATE TABLE "issue_flow" ("id" uuid PRIMARY KEY, "name" text NOT NULL);',
      'ALTER TABLE "issues" ADD COLUMN "flow_id" uuid;',
      'CREATE INDEX IF NOT EXISTS "issues_flow_idx" ON "issues" ("flow_id");',
      'ALTER TABLE "issues" ALTER COLUMN "title" DROP NOT NULL;',
      'ALTER TABLE "issues" ALTER COLUMN "rank" DROP DEFAULT;',
      'ALTER TYPE "status" ADD VALUE \'archived\';',
      'UPDATE "issues" SET "flow_id" = NULL;',
    ].join("\n");
    expect(findDestructiveStatements(sql)).toEqual([]);
  });

  it("ignores keywords inside comments and string literals", () => {
    const sql = [
      "-- DROP TABLE users; was considered",
      "/* TRUNCATE everything",
      "   DELETE FROM x */",
      "INSERT INTO notes (body) VALUES ('please do not rename or drop table t; it''s fine');",
    ].join("\n");
    expect(findDestructiveStatements(sql)).toEqual([]);
  });

  it("matches case-insensitively and across line breaks", () => {
    const sql = 'alter table "x"\n  drop\n  constraint "x_fk";\ndelete\nfrom "y";';
    expect(findDestructiveStatements(sql).map(({ line, kind }) => ({ line, kind }))).toEqual([
      { line: 2, kind: "drop" },
      { line: 4, kind: "delete" },
    ]);
  });
});

describe("parseArgs", () => {
  it("requires --issue and applies defaults", () => {
    expect(() => parseArgs([])).toThrow(/--issue is required/);
    expect(parseArgs(["--issue", "OPT-1"])).toEqual({
      issue: "OPT-1",
      branch: null,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      pollIntervalMs: 15_000,
      instanceId: "default",
    });
  });

  it("parses every option, including --flag=value and pnpm's -- separator", () => {
    expect(parseArgs(["--", "--issue=OPT-9", "--branch", "feat/x", "--idle-timeout", "90s", "--poll-interval=2s", "--instance", "safe-restart-test"]))
      .toEqual({ issue: "OPT-9", branch: "feat/x", idleTimeoutMs: 90_000, pollIntervalMs: 2_000, instanceId: "safe-restart-test" });
  });

  it("takes the instance from PAPERCLIP_INSTANCE_ID when not given", () => {
    expect(parseArgs(["--issue", "OPT-1"], { PAPERCLIP_INSTANCE_ID: "other" }).instanceId).toBe("other");
  });

  it("rejects unknown flags, missing values and bad instance ids", () => {
    expect(() => parseArgs(["--issue", "OPT-1", "--force"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--issue", "--branch", "x"])).toThrow(/Missing value for --issue/);
    expect(() => parseArgs(["--issue", "OPT-1", "--instance", "../prod"])).toThrow(/Invalid instance id/);
  });
});

describe("parseDuration", () => {
  it("understands ms, s, m, h and bare seconds", () => {
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("45")).toBe(45_000);
    expect(parseDuration("20m")).toBe(1_200_000);
    expect(parseDuration("1.5h")).toBe(5_400_000);
    expect(() => parseDuration("soon")).toThrow(/Invalid duration/);
  });
});

describe("parsePsEnvironment", () => {
  it("strips the argv prefix and splits NAME=value pairs", () => {
    const args = "node /opt/homebrew/bin/pnpm paperclipai run";
    const withEnv = `${args} HOME=/Users/a PATH=/a/node_modules/.bin:/opt/homebrew/bin PAPERCLIP_INSTANCE_ID=default EMPTY= X=a=b\n`;
    expect(parsePsEnvironment(withEnv, `${args}\n`)).toEqual({
      HOME: "/Users/a",
      PATH: "/a/node_modules/.bin:/opt/homebrew/bin",
      PAPERCLIP_INSTANCE_ID: "default",
      EMPTY: "",
      X: "a=b",
    });
  });
});

describe("buildRelaunchEnv", () => {
  const base = { homeDir: "/Users/real", repoRoot: "/repo", instanceId: "safe-restart-test" };

  it("keeps the server environment but removes run-scoped and package-manager variables", () => {
    const env = buildRelaunchEnv({
      ...base,
      callerEnv: {},
      serverEnv: {
        HOME: "/Users/real",
        PATH: "/repo/node_modules/.bin:/x/node-gyp-bin:/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/opt/homebrew/bin",
        OPENAI_API_KEY: "keep-me",
        PAPERCLIP_HOME: "/Users/real/.paperclip",
        PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
        PAPERCLIP_API_KEY: "agent-jwt",
        PAPERCLIP_API_URL: "http://127.0.0.1:3100/api",
        PAPERCLIP_RUN_ID: "run",
        PAPERCLIP_AGENT_ID: "agent",
        PAPERCLIP_TASK_ID: "task",
        PAPERCLIP_WAKE_REASON: "issue_assigned",
        PAPERCLIP_WORKSPACE_CWD: "/tmp/ws",
        PAPERCLIP_COMPANY_ID: "company",
        PAPERCLIP_MIGRATION_PROMPT: "never",
        npm_config_user_agent: "pnpm",
        npm_lifecycle_event: "paperclipai",
        PNPM_SCRIPT_SRC_DIR: "/repo",
        INIT_CWD: "/repo",
      },
    });
    expect(env).toEqual({
      HOME: "/Users/real",
      PATH: "/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin",
      OPENAI_API_KEY: "keep-me",
      PAPERCLIP_HOME: "/Users/real/.paperclip",
      PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
      PWD: "/repo",
      PAPERCLIP_INSTANCE_ID: "safe-restart-test",
      PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
    });
  });

  it("falls back to an allowlist of the caller env with the account HOME, never the agent scratch HOME", () => {
    const env = buildRelaunchEnv({
      ...base,
      serverEnv: null,
      callerEnv: {
        HOME: "/var/folders/agent-scratch",
        PATH: "/opt/homebrew/bin",
        USER: "alexis",
        LANG: "fr_FR.UTF-8",
        LC_ALL: "fr_FR.UTF-8",
        TMPDIR: "/var/folders/agent-scratch/tmp",
        PAPERCLIP_API_KEY: "agent-jwt",
        PAPERCLIP_RUN_ID: "run",
        SECRET_TOKEN: "nope",
      },
    });
    expect(env).toEqual({
      HOME: "/Users/real",
      PATH: "/opt/homebrew/bin",
      USER: "alexis",
      LANG: "fr_FR.UTF-8",
      LC_ALL: "fr_FR.UTF-8",
      PWD: "/repo",
      PAPERCLIP_INSTANCE_ID: "safe-restart-test",
      PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
    });
  });
});

describe("countLiveRuns", () => {
  it("sums run ids across companies and ignores malformed payloads", () => {
    expect(countLiveRuns([[{ id: "a" }, { id: "b" }], [], { error: "x" }, [{ nope: 1 }]]))
      .toEqual({ count: 2, runIds: ["a", "b"] });
  });
});

describe("formatOutcomeComment", () => {
  const outcome: RestartOutcome = {
    status: "aborted",
    reason: "une migration en attente contient du SQL destructif",
    issue: "OPT-1",
    instanceId: "safe-restart-test",
    branch: "feat/x",
    commit: "0123456789abcdef",
    startedAt: "2026-11-02T10:00:00.000Z",
    finishedAt: "2026-11-02T10:01:05.000Z",
    previousProcessStartedAt: "2026-11-02T09:00:00.000Z",
    newProcessStartedAt: null,
    pendingMigrations: ["0313_drop.sql"],
    destructive: [{ file: "0313_drop.sql", findings: [{ line: 3, kind: "drop", text: 'ALTER TABLE "x" DROP COLUMN `y`;' }] }],
    idle: null,
    report: null,
    logPath: "/tmp/safe-restart.log",
    logTail: ["line 1", "line 2"],
  };

  it("lists destructive files and lines and says the server was not stopped", () => {
    const body = formatOutcomeComment(outcome);
    expect(body).toContain("Redémarrage sûr : annulé, serveur non arrêté");
    expect(body).toContain("`0313_drop.sql` ligne 3 (drop)");
    expect(body).toContain("DROP COLUMN 'y'");
    expect(body).toContain("Durée : 1 min 05 s");
    expect(body).toContain("line 2");
  });

  it("reports adopted, finalized and lost runs on success", () => {
    const body = formatOutcomeComment({
      ...outcome,
      status: "succeeded",
      reason: null,
      destructive: [],
      pendingMigrations: [],
      newProcessStartedAt: "2026-11-02T10:01:00.000Z",
      idle: { reachedZero: false, remainingRunIds: ["r1"], waitedMs: 1_200_000 },
      report: { adoptedRunIds: ["r1"], finalizedWhileDownRunIds: [], lostRunIds: [], drainReason: null },
    });
    expect(body).toContain("Redémarrage sûr : succès");
    expect(body).toContain("Migrations en attente : aucune");
    expect(body).toContain("échéance atteinte, runs encore actifs : `r1`");
    expect(body).toContain("Runs adoptés : `r1`");
    expect(body).toContain("Runs perdus : aucun");
  });
});
