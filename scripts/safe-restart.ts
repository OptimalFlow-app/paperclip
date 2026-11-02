/**
 * Safe, detached restart of a local Paperclip instance started with
 * `pnpm paperclipai run` from this checkout.
 *
 *   pnpm safe-restart --issue OPT-123 [--branch feat/x] [--idle-timeout 20m] [--instance default]
 *
 * The launcher runs fast preflight checks (branch, clean tree, lockfile, lock),
 * then spawns a detached worker (new session) and returns. The worker:
 *   1. refuses pending migrations that contain destructive SQL (before any stop);
 *   2. waits for zero live runs (two consecutive polls) up to --idle-timeout;
 *   3. backs the database up when ordinary migrations are pending;
 *   4. writes the hot-restart marker, sends SIGTERM, waits for the server AND its
 *      embedded PostgreSQL to stop (never SIGKILL);
 *   5. relaunches `pnpm paperclipai run` with a cleaned environment;
 *   6. checks /api/health for a newer processStartedAt, reads hot-restart-report.json
 *      and comments the --issue with the outcome.
 * If the server does not come back: one relaunch retry, then a macOS notification
 * and `<instance>/data/safe-restart-last.json`.
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in scripts/__tests__/safe-restart.test.ts)
// ---------------------------------------------------------------------------

export interface SafeRestartOptions {
  issue: string;
  branch: string | null;
  idleTimeoutMs: number;
  pollIntervalMs: number;
  instanceId: string;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 20 * 60_000;
export const DEFAULT_POLL_INTERVAL_MS = 15_000;

export const USAGE = [
  "Usage: pnpm safe-restart --issue <OPT-123> [--branch <name>] [--idle-timeout 20m] [--instance <id>]",
  "",
  "Checks the checkout, then restarts the local Paperclip server from a detached worker:",
  "waits for idle, writes the hot-restart marker, stops, relaunches, comments the issue.",
].join("\n");

export function parseDuration(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(raw.trim());
  if (!match) throw new Error(`Invalid duration: ${raw} (examples: 90s, 20m, 1h)`);
  const value = Number(match[1]);
  const unit = match[2] ?? "s";
  const factor = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(value * factor);
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = {}): SafeRestartOptions {
  let issue: string | null = null;
  let branch: string | null = null;
  let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  let instanceId = env.PAPERCLIP_INSTANCE_ID?.trim() || "default";

  const takeValue = (index: number, flag: string) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];
    const value = () => {
      if (inline !== null) return inline;
      const next = takeValue(index, flag);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--issue":
        issue = value().trim();
        break;
      case "--branch":
        branch = value().trim();
        break;
      case "--idle-timeout":
        idleTimeoutMs = parseDuration(value());
        break;
      case "--poll-interval":
        pollIntervalMs = parseDuration(value());
        break;
      case "--instance":
        instanceId = value().trim();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!issue) throw new Error("--issue is required (the issue that receives the restart report)");
  if (!/^[a-zA-Z0-9_-]+$/.test(instanceId)) throw new Error(`Invalid instance id: ${instanceId}`);
  if (pollIntervalMs < 1_000) throw new Error("--poll-interval must be at least 1s");
  return { issue, branch, idleTimeoutMs, pollIntervalMs, instanceId };
}

export interface DestructiveFinding {
  line: number;
  kind: "drop" | "truncate" | "delete" | "alter_type" | "rename";
  text: string;
}

/**
 * Blank out SQL comments and single-quoted string literals while keeping
 * offsets and newlines, so keyword matches map back to the original lines.
 */
function maskSqlCommentsAndStrings(sql: string): string {
  const out = sql.split("");
  let index = 0;
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      const stop = end === -1 ? sql.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === "'") {
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === "'" && sql[cursor + 1] === "'") {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === "'") break;
        cursor += 1;
      }
      blank(index + 1, cursor);
      index = cursor + 1;
      continue;
    }
    index += 1;
  }
  return out.join("");
}

const DESTRUCTIVE_PATTERNS: Array<{ kind: DestructiveFinding["kind"]; regex: RegExp }> = [
  // DROP DEFAULT / DROP NOT NULL only relax a column constraint: no data is lost.
  { kind: "drop", regex: /\bDROP\s+(?!DEFAULT\b|NOT\s+NULL\b)[A-Z]/gi },
  { kind: "truncate", regex: /\bTRUNCATE\b/gi },
  { kind: "delete", regex: /\bDELETE\s+FROM\b/gi },
  { kind: "alter_type", regex: /\bALTER\s+COLUMN\s+(?:"[^"]+"|\S+)\s+(?:SET\s+DATA\s+)?TYPE\b/gi },
  { kind: "rename", regex: /\bRENAME\b/gi },
];

/** Pure detector: returns every destructive statement start found in a migration. */
export function findDestructiveStatements(sql: string): DestructiveFinding[] {
  const masked = maskSqlCommentsAndStrings(sql);
  const lines = sql.split("\n");
  const lineStarts: number[] = [0];
  for (let i = 0; i < sql.length; i += 1) {
    if (sql[i] === "\n") lineStarts.push(i + 1);
  }
  const lineOf = (offset: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  const findings: DestructiveFinding[] = [];
  const seen = new Set<string>();
  for (const { kind, regex } of DESTRUCTIVE_PATTERNS) {
    regex.lastIndex = 0;
    for (const match of masked.matchAll(regex)) {
      const line = lineOf(match.index ?? 0);
      const key = `${line}:${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ line, kind, text: (lines[line - 1] ?? "").trim().slice(0, 200) });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
}

/**
 * `ps eww -o command= -p <pid>` prints the argv followed by the environment.
 * Pass the argv-only line (`ps -o args=`) to strip it reliably.
 */
export function parsePsEnvironment(psWithEnv: string, argsOnly: string): Record<string, string> {
  const full = psWithEnv.replace(/\n+$/, "");
  const args = argsOnly.replace(/\n+$/, "");
  const rest = full.startsWith(args) ? full.slice(args.length) : full;
  const env: Record<string, string> = {};
  const parts = rest.trim().split(/ (?=[A-Za-z_][A-Za-z0-9_]*=)/);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = part.slice(eq + 1);
  }
  return env;
}

/** PAPERCLIP_* variables injected into agent runs; they must never reach a server. */
const RUN_SCOPED_PAPERCLIP_VARS = [
  /^PAPERCLIP_RUN_/,
  /^PAPERCLIP_AGENT_/,
  /^PAPERCLIP_TASK_/,
  /^PAPERCLIP_WAKE_/,
  /^PAPERCLIP_ISSUE_/,
  /^PAPERCLIP_WORKSPACE_/,
  /^PAPERCLIP_RUNNER_/,
  /^PAPERCLIP_AI_PROVIDER_/,
  /^PAPERCLIP_GITHUB_/,
  /^PAPERCLIP_API_(KEY|URL)$/,
  /^PAPERCLIP_(COMPANY_ID|SCRATCH_DIR|TMPDIR|GIT_METADATA_ROOTS|CODEX_PROVIDERS|OPENCODE_PROVIDERS)$/,
  /^PAPERCLIP_MIGRATION_PROMPT$/,
];
const PACKAGE_MANAGER_VARS = [/^npm_/i, /^PNPM_/, /^INIT_CWD$/, /^NODE$/, /^COREPACK_ROOT$/, /^SAFE_RESTART_/];
const FALLBACK_ALLOWLIST = ["PATH", "USER", "LOGNAME", "SHELL", "LANG", "TZ", "PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_CONFIG"];

export function isRunScopedVariable(key: string) {
  return RUN_SCOPED_PAPERCLIP_VARS.some((pattern) => pattern.test(key))
    || PACKAGE_MANAGER_VARS.some((pattern) => pattern.test(key));
}

/**
 * Environment for the relaunched server. Prefer the environment the current
 * server was started with; otherwise an allowlist of the caller's environment.
 * Agent-run PAPERCLIP_* variables and package-manager noise are always removed.
 */
export function buildRelaunchEnv(input: {
  serverEnv: Record<string, string> | null;
  callerEnv: NodeJS.ProcessEnv;
  homeDir: string;
  repoRoot: string;
  instanceId: string;
}): Record<string, string> {
  const base: Record<string, string> = {};
  if (input.serverEnv && Object.keys(input.serverEnv).length > 0) {
    Object.assign(base, input.serverEnv);
  } else {
    for (const [key, value] of Object.entries(input.callerEnv)) {
      if (value === undefined) continue;
      if (FALLBACK_ALLOWLIST.includes(key) || key.startsWith("LC_")) base[key] = value;
    }
  }
  for (const key of Object.keys(base)) {
    if (isRunScopedVariable(key)) delete base[key];
  }
  if (!base.HOME) base.HOME = input.homeDir;
  base.PATH = (base.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
    .split(":")
    .filter((entry) => entry && !entry.includes("/node_modules/.bin") && !entry.includes("node-gyp-bin"))
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .join(":");
  base.PWD = input.repoRoot;
  base.PAPERCLIP_INSTANCE_ID = input.instanceId;
  base.PAPERCLIP_MIGRATION_AUTO_APPLY = "true";
  return base;
}

export function countLiveRuns(payloads: unknown[]): { count: number; runIds: string[] } {
  const runIds: string[] = [];
  for (const payload of payloads) {
    if (!Array.isArray(payload)) continue;
    for (const run of payload) {
      if (run && typeof run === "object" && typeof (run as { id?: unknown }).id === "string") {
        runIds.push((run as { id: string }).id);
      }
    }
  }
  return { count: runIds.length, runIds };
}

export interface RestartOutcome {
  status: "succeeded" | "aborted" | "failed";
  reason: string | null;
  issue: string;
  instanceId: string;
  branch: string | null;
  commit: string | null;
  startedAt: string;
  finishedAt: string;
  previousProcessStartedAt: string | null;
  newProcessStartedAt: string | null;
  pendingMigrations: string[];
  destructive: Array<{ file: string; findings: DestructiveFinding[] }>;
  idle: { reachedZero: boolean; remainingRunIds: string[]; waitedMs: number } | null;
  report: {
    adoptedRunIds: string[];
    finalizedWhileDownRunIds: string[];
    lostRunIds: string[];
    drainReason: string | null;
  } | null;
  logPath: string;
  logTail: string[];
}

function formatDurationMs(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
}

const idList = (ids: string[]) => (ids.length === 0 ? "aucun" : ids.map((id) => `\`${id}\``).join(", "));

export function formatOutcomeComment(outcome: RestartOutcome): string {
  const title = outcome.status === "succeeded"
    ? "Redémarrage sûr : succès"
    : outcome.status === "aborted"
      ? "Redémarrage sûr : annulé, serveur non arrêté"
      : "Redémarrage sûr : échec";
  const lines: string[] = [`## ${title}`, ""];
  if (outcome.reason) lines.push(`**Raison** : ${outcome.reason}`, "");
  const duration = Date.parse(outcome.finishedAt) - Date.parse(outcome.startedAt);
  lines.push(
    `- Instance : \`${outcome.instanceId}\`, branche \`${outcome.branch ?? "?"}\`, commit \`${outcome.commit?.slice(0, 9) ?? "?"}\``,
    `- Durée : ${formatDurationMs(Number.isFinite(duration) ? duration : 0)}`,
    `- Serveur : démarré le ${outcome.previousProcessStartedAt ?? "?"} → ${outcome.newProcessStartedAt ?? "pas de nouveau processus"}`,
    `- Migrations en attente : ${outcome.pendingMigrations.length === 0 ? "aucune" : outcome.pendingMigrations.map((name) => `\`${name}\``).join(", ")}`,
  );
  if (outcome.idle) {
    lines.push(outcome.idle.reachedZero
      ? `- Attente d'inactivité : zéro run atteint après ${formatDurationMs(outcome.idle.waitedMs)}`
      : `- Attente d'inactivité : échéance atteinte, runs encore actifs : ${idList(outcome.idle.remainingRunIds)}`);
  }
  if (outcome.report) {
    lines.push(
      `- Runs adoptés : ${idList(outcome.report.adoptedRunIds)}`,
      `- Runs finalisés pendant l'arrêt (repris) : ${idList(outcome.report.finalizedWhileDownRunIds)}`,
      `- Runs perdus : ${idList(outcome.report.lostRunIds)}`,
    );
    if (outcome.report.drainReason) lines.push(`- Drain : \`${outcome.report.drainReason}\``);
  }
  if (outcome.destructive.length > 0) {
    lines.push("", "### SQL destructif dans les migrations en attente", "");
    for (const entry of outcome.destructive) {
      for (const finding of entry.findings) {
        lines.push(`- \`${entry.file}\` ligne ${finding.line} (${finding.kind}) : \`${finding.text.replaceAll("`", "'")}\``);
      }
    }
    lines.push("", "Le serveur n'a pas été arrêté. Appliquer ces migrations demande un redémarrage manuel validé par un fondateur.");
  }
  lines.push("", `Log : \`${outcome.logPath}\``, "", "<details><summary>Fin du log</summary>", "", "```text", ...outcome.logTail, "```", "", "</details>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Process and filesystem helpers
// ---------------------------------------------------------------------------

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const TSX_CLI = path.join(REPO_ROOT, "cli", "node_modules", "tsx", "dist", "cli.mjs");

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function git(args: string[]) {
  const result = run("git", ["-C", REPO_ROOT, ...args]);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Async variants let the launcher run its probes in parallel (2 s budget).
function runAsync(command: string, args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const status = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ status, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

async function gitAsync(args: string[]) {
  const result = await runAsync("git", ["-C", REPO_ROOT, ...args]);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function processCwd(pid: number): Promise<string | null> {
  const result = await runAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("n"));
  return line ? line.slice(1) : null;
}

/** The server pid plus the `pnpm paperclipai run` / tsx wrappers that launched it. */
async function serverProcessChain(serverPid: number): Promise<number[]> {
  const table = new Map<number, { ppid: number; args: string }>();
  for (const line of (await runAsync("ps", ["-axo", "pid=,ppid=,args="])).stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), args: match[3] });
  }
  const chain = [serverPid];
  let current = table.get(serverPid)?.ppid ?? 0;
  while (current > 1 && /paperclipai run|cli\/src\/index\.ts run/.test(table.get(current)?.args ?? "")) {
    chain.push(current);
    current = table.get(current)?.ppid ?? 0;
  }
  return chain;
}

async function readProcessEnv(pid: number): Promise<Record<string, string> | null> {
  const [withEnv, argsOnly] = await Promise.all([
    runAsync("ps", ["eww", "-o", "command=", "-p", String(pid)]),
    runAsync("ps", ["-o", "command=", "-p", String(pid)]),
  ]);
  if (withEnv.status !== 0 || argsOnly.status !== 0) return null;
  const env = parsePsEnvironment(withEnv.stdout, argsOnly.stdout);
  return Object.keys(env).length > 0 ? env : null;
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

interface InstancePaths {
  homeDir: string;
  instanceRoot: string;
  logsDir: string;
  dataDir: string;
  lockPath: string;
  runtimeInfoPath: string;
  reportPath: string;
  lastResultPath: string;
  configPath: string;
}

function resolveInstancePaths(instanceId: string, env: NodeJS.ProcessEnv): InstancePaths {
  // Agent runs override HOME with a scratch directory: use the account home.
  const homeDir = os.userInfo().homedir;
  const paperclipHome = env.PAPERCLIP_HOME?.trim()
    ? path.resolve(env.PAPERCLIP_HOME.trim().replace(/^~(?=$|\/)/, homeDir))
    : path.join(homeDir, ".paperclip");
  const instanceRoot = path.join(paperclipHome, "instances", instanceId);
  return {
    homeDir,
    instanceRoot,
    logsDir: path.join(instanceRoot, "logs"),
    dataDir: path.join(instanceRoot, "data"),
    lockPath: path.join(instanceRoot, "safe-restart.lock"),
    runtimeInfoPath: path.join(instanceRoot, "runtime-info.json"),
    reportPath: path.join(instanceRoot, "hot-restart-report.json"),
    lastResultPath: path.join(instanceRoot, "data", "safe-restart-last.json"),
    configPath: path.join(instanceRoot, "config.json"),
  };
}

interface HealthSnapshot {
  processStartedAt: string | null;
  branchName: string | null;
}

async function fetchHealth(apiBase: string, timeoutMs = 3_000): Promise<HealthSnapshot | null> {
  try {
    const response = await fetch(`${apiBase}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const body = await response.json() as { serverInfo?: { processStartedAt?: unknown; git?: { branchName?: unknown } } };
    return {
      processStartedAt: typeof body.serverInfo?.processStartedAt === "string" ? body.serverInfo.processStartedAt : null,
      branchName: typeof body.serverInfo?.git?.branchName === "string" ? body.serverInfo.git.branchName : null,
    };
  } catch {
    return null;
  }
}

/** Calls the instance API with the agent key, falling back to the local board actor. */
async function apiRequest(apiBase: string, apiKey: string | null, pathname: string, init: RequestInit = {}) {
  const attempt = (withKey: boolean) => fetch(`${apiBase}${pathname}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(withKey && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (apiKey) {
    const response = await attempt(true);
    if (response.status !== 401 && response.status !== 403) return response;
  }
  return attempt(false);
}

// ---------------------------------------------------------------------------
// Launcher: fast preflight, then detach
// ---------------------------------------------------------------------------

interface WorkerState {
  options: SafeRestartOptions;
  paths: InstancePaths;
  apiBase: string;
  serverPid: number;
  serverChain: number[];
  previousProcessStartedAt: string | null;
  branch: string;
  commit: string;
  relaunchEnv: Record<string, string>;
  requestedByRunId: string | null;
  logPath: string;
  startedAt: string;
}

function fail(message: string): never {
  console.error(`safe-restart: ${message}`);
  process.exit(1);
}

function acquireLock(lockPath: string, pid: number) {
  const payload = `${JSON.stringify({ pid, createdAt: new Date().toISOString() })}\n`;
  try {
    fs.writeFileSync(lockPath, payload, { flag: "wx" });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const existing = readJson<{ pid?: number; createdAt?: string }>(lockPath);
  if (existing?.pid && isPidAlive(existing.pid)) {
    fail(`a restart is already in progress (pid ${existing.pid}, since ${existing.createdAt ?? "?"}; lock ${lockPath})`);
  }
  fs.writeFileSync(lockPath, payload);
}

async function runLauncher(argv: string[]) {
  let options: SafeRestartOptions;
  try {
    options = parseArgs(argv, process.env);
  } catch (error) {
    console.error(`safe-restart: ${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }

  const paths = resolveInstancePaths(options.instanceId, process.env);
  const runtimeInfo = readJson<{ pid?: number; host?: string; port?: number }>(paths.runtimeInfoPath);
  if (!runtimeInfo?.pid || !runtimeInfo.port) fail(`no running server recorded in ${paths.runtimeInfoPath}`);
  const serverPid = runtimeInfo.pid;
  if (!isPidAlive(serverPid)) fail(`server pid ${serverPid} from ${paths.runtimeInfoPath} is not running`);
  const apiBase = `http://${runtimeInfo.host && runtimeInfo.host !== "0.0.0.0" ? runtimeInfo.host : "127.0.0.1"}:${runtimeInfo.port}`;
  const apiKey = process.env.PAPERCLIP_API_KEY?.trim() || null;

  // Independent probes run in parallel; each check below fails fast in order.
  const [serverCwd, revParse, dirty, health, issueResponse, serverChain] = await Promise.all([
    processCwd(serverPid),
    gitAsync(["rev-parse", "--abbrev-ref", "HEAD", "HEAD"]),
    gitAsync(["status", "--porcelain"]),
    fetchHealth(apiBase),
    apiRequest(apiBase, apiKey, `/api/issues/${encodeURIComponent(options.issue)}`).catch(() => null),
    serverProcessChain(serverPid),
  ]);
  if (!serverCwd || fs.realpathSync(serverCwd) !== fs.realpathSync(REPO_ROOT)) {
    fail(`server pid ${serverPid} runs from ${serverCwd ?? "?"}, not from this checkout (${REPO_ROOT}); run the script from the server's checkout`);
  }

  const [branch, commit] = revParse.split("\n");
  if (branch === "HEAD") fail("the checkout is on a detached HEAD");
  if (options.branch && options.branch !== branch) {
    fail(`checkout is on branch '${branch}', expected '${options.branch}' (the script never switches branches)`);
  }
  if (dirty) fail(`the working tree has local changes:\n${dirty}`);

  const lockfile = path.join(REPO_ROOT, "pnpm-lock.yaml");
  const installedLockfile = path.join(REPO_ROOT, "node_modules", ".pnpm", "lock.yaml");
  if (fs.existsSync(installedLockfile)) {
    if (!fs.readFileSync(lockfile).equals(fs.readFileSync(installedLockfile))) {
      fail("pnpm-lock.yaml differs from the installed dependencies (node_modules/.pnpm/lock.yaml): run pnpm install first");
    }
  } else {
    fail("node_modules/.pnpm/lock.yaml is missing: dependencies are not installed in this checkout");
  }

  if (!health) fail(`server at ${apiBase} does not answer /api/health`);
  if (!issueResponse?.ok) fail(`issue ${options.issue} is not readable on ${apiBase} (HTTP ${issueResponse?.status ?? "error"})`);

  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.mkdirSync(paths.dataDir, { recursive: true });
  acquireLock(paths.lockPath, process.pid);

  const serverEnv = (await readProcessEnv(serverChain[serverChain.length - 1])) ?? (await readProcessEnv(serverPid));
  const relaunchEnv = buildRelaunchEnv({
    serverEnv,
    callerEnv: process.env,
    homeDir: paths.homeDir,
    repoRoot: REPO_ROOT,
    instanceId: options.instanceId,
  });

  const startedAt = new Date();
  const logPath = path.join(paths.logsDir, `safe-restart-${timestampForFile(startedAt)}.log`);
  const state: WorkerState = {
    options,
    paths,
    apiBase,
    serverPid,
    serverChain,
    previousProcessStartedAt: health.processStartedAt,
    branch,
    commit,
    relaunchEnv,
    requestedByRunId: process.env.PAPERCLIP_RUN_ID?.trim() || null,
    logPath,
    startedAt: startedAt.toISOString(),
  };

  const logFd = fs.openSync(logPath, "a");
  const worker = spawn(process.execPath, [TSX_CLI, SCRIPT_PATH, "--worker"], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...relaunchEnv,
      SAFE_RESTART_STATE: JSON.stringify(state),
      ...(apiKey ? { SAFE_RESTART_API_KEY: apiKey } : {}),
    },
  });
  worker.unref();
  fs.closeSync(logFd);
  if (!worker.pid) {
    fs.rmSync(paths.lockPath, { force: true });
    fail("could not spawn the detached worker");
  }
  fs.writeFileSync(paths.lockPath, `${JSON.stringify({ pid: worker.pid, createdAt: state.startedAt, logPath })}\n`);

  console.log([
    `safe-restart: checks passed (branch ${branch}, clean tree, lockfile installed).`,
    `Detached worker pid ${worker.pid} will wait for idle (max ${formatDurationMs(options.idleTimeoutMs)}), restart ${apiBase} and comment ${options.issue}.`,
    `Log: ${logPath}`,
    `Launcher returned after ${process.uptime().toFixed(2)} s.`,
  ].join("\n"));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Worker: runs detached, survives the caller
// ---------------------------------------------------------------------------

class Abort extends Error {}

async function runWorker() {
  const state = JSON.parse(process.env.SAFE_RESTART_STATE ?? "null") as WorkerState | null;
  if (!state) throw new Error("SAFE_RESTART_STATE is missing");
  const apiKey = process.env.SAFE_RESTART_API_KEY?.trim() || null;
  delete process.env.SAFE_RESTART_STATE;
  delete process.env.SAFE_RESTART_API_KEY;
  const { options, paths, apiBase } = state;

  const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
  const outcome: RestartOutcome = {
    status: "failed",
    reason: null,
    issue: options.issue,
    instanceId: options.instanceId,
    branch: state.branch,
    commit: state.commit,
    startedAt: state.startedAt,
    finishedAt: state.startedAt,
    previousProcessStartedAt: state.previousProcessStartedAt,
    newProcessStartedAt: null,
    pendingMigrations: [],
    destructive: [],
    idle: null,
    report: null,
    logPath: state.logPath,
    logTail: [],
  };
  let serverStopped = false;
  // The launcher recorded the tsx wrapper pid; own the lock with the real worker pid.
  fs.writeFileSync(paths.lockPath, `${JSON.stringify({ pid: process.pid, createdAt: state.startedAt, logPath: state.logPath })}\n`);

  log(`worker pid ${process.pid} (pgid/session detached) for ${apiBase}, server pid ${state.serverPid}, issue ${options.issue}`);

  try {
    // 1. Pending migrations, before anything is stopped.
    const { inspectMigrations } = await import("../packages/db/src/index.js");
    const { loadConfig } = await import("../server/src/config.js");
    const config = loadConfig();
    // The server may move embedded PostgreSQL to a free port at boot: trust
    // postmaster.pid (line 1 = pid, line 4 = port) over the configured port.
    const postmasterPidPath = path.join(config.embeddedPostgresDataDir, "postmaster.pid");
    const resolveDatabase = () => {
      const postmaster = config.databaseMode === "embedded-postgres" && fs.existsSync(postmasterPidPath)
        ? fs.readFileSync(postmasterPidPath, "utf8").split("\n")
        : [];
      const port = Number(postmaster[3]) || config.embeddedPostgresPort;
      return {
        pid: Number(postmaster[0]) || null,
        port,
        url: process.env.DATABASE_URL?.trim()
          || config.databaseUrl
          || `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
      };
    };
    const { pid: postgresPid, port: postgresPort, url: dbUrl } = resolveDatabase();
    log(`database: ${config.databaseMode}${postgresPid ? ` (postgres pid ${postgresPid}, port ${postgresPort})` : ""}`);
    const migrationState = await inspectMigrations(dbUrl);
    outcome.pendingMigrations = migrationState.status === "needsMigrations" ? migrationState.pendingMigrations : [];
    log(`pending migrations: ${outcome.pendingMigrations.length === 0 ? "none" : outcome.pendingMigrations.join(", ")}`);
    const migrationsDir = path.join(REPO_ROOT, "packages", "db", "src", "migrations");
    for (const file of outcome.pendingMigrations) {
      const findings = findDestructiveStatements(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
      if (findings.length > 0) outcome.destructive.push({ file, findings });
    }
    if (outcome.destructive.length > 0) {
      for (const entry of outcome.destructive) {
        for (const finding of entry.findings) log(`destructive SQL ${entry.file}:${finding.line} (${finding.kind}) ${finding.text}`);
      }
      throw new Abort("une migration en attente contient du SQL destructif");
    }

    // 2. Wait for idle: two consecutive polls with zero live runs, up to the timeout.
    const idleStart = Date.now();
    let zeroStreak = 0;
    let remaining: string[] = [];
    while (true) {
      const health = await fetchHealth(apiBase);
      if (!health) throw new Abort("le serveur ne répond plus pendant l'attente d'inactivité");
      if (health.processStartedAt !== state.previousProcessStartedAt) {
        throw new Abort(`le serveur a redémarré entre-temps (processStartedAt ${health.processStartedAt})`);
      }
      const companiesResponse = await apiRequest(apiBase, apiKey, "/api/companies");
      if (!companiesResponse.ok) throw new Abort(`GET /api/companies a répondu ${companiesResponse.status}`);
      const companies = await companiesResponse.json() as Array<{ id: string }>;
      const payloads: unknown[] = [];
      for (const company of companies) {
        const response = await apiRequest(apiBase, apiKey, `/api/companies/${company.id}/live-runs`);
        if (!response.ok) throw new Abort(`GET live-runs (${company.id}) a répondu ${response.status}`);
        payloads.push(await response.json());
      }
      const live = countLiveRuns(payloads);
      remaining = live.runIds;
      zeroStreak = live.count === 0 ? zeroStreak + 1 : 0;
      log(`live runs: ${live.count}${live.count ? ` (${live.runIds.join(", ")})` : ""}`);
      if (zeroStreak >= 2) {
        outcome.idle = { reachedZero: true, remainingRunIds: [], waitedMs: Date.now() - idleStart };
        break;
      }
      if (Date.now() - idleStart >= options.idleTimeoutMs) {
        outcome.idle = { reachedZero: false, remainingRunIds: remaining, waitedMs: Date.now() - idleStart };
        log(`idle timeout reached; the hot-restart marker covers ${remaining.length} remaining run(s)`);
        break;
      }
      await sleep(options.pollIntervalMs);
    }

    // The checkout may have moved during the wait: re-check before stopping.
    const commitNow = git(["rev-parse", "HEAD"]);
    if (commitNow !== state.commit) throw new Abort(`le checkout a changé pendant l'attente (${state.commit.slice(0, 9)} → ${commitNow.slice(0, 9)})`);
    if (git(["status", "--porcelain"])) throw new Abort("l'arbre de travail a des modifications locales apparues pendant l'attente");

    // 3. Backup when ordinary migrations will be applied.
    if (outcome.pendingMigrations.length > 0) {
      log("backing up the database before applying migrations");
      const backup = run(path.join(REPO_ROOT, "scripts", "backup-db.sh"), [], { cwd: REPO_ROOT, env: state.relaunchEnv });
      log(backup.stdout.trim().split("\n").slice(-5).join("\n"));
      if (backup.status !== 0) throw new Abort(`la sauvegarde de la base a échoué : ${backup.stderr.trim().split("\n").slice(-3).join(" ")}`);
    }

    // 4. Hot-restart marker, SIGTERM, wait for server and embedded PostgreSQL.
    log(`writing the hot-restart marker for pid ${state.serverPid}`);
    const marker = run("pnpm", ["--filter", "@paperclipai/server", "exec", "tsx", "../scripts/request-hot-restart.ts", "--server-pid", String(state.serverPid)], {
      cwd: REPO_ROOT,
      env: {
        ...state.relaunchEnv,
        PAPERCLIP_API_URL: apiBase,
        DATABASE_URL: dbUrl,
        ...(state.requestedByRunId ? { PAPERCLIP_RUN_ID: state.requestedByRunId } : {}),
      },
    });
    log(marker.stdout.trim());
    if (marker.status !== 0) throw new Abort(`request-hot-restart a échoué : ${marker.stderr.trim().split("\n").slice(-3).join(" ")}`);

    log(`sending SIGTERM to server pid ${state.serverPid}${postgresPid ? ` (embedded postgres pid ${postgresPid})` : ""}`);
    process.kill(state.serverPid, "SIGTERM");
    serverStopped = true;

    const stopDeadline = Date.now() + 5 * 60_000;
    const stillRunning = () => [
      ...state.serverChain.filter(isPidAlive).map((pid) => `server ${pid}`),
      ...(postgresPid && isPidAlive(postgresPid) ? [`postgres ${postgresPid}`] : []),
    ];
    while (stillRunning().length > 0 && Date.now() < stopDeadline) await sleep(1_000);
    const leftovers = stillRunning();
    if (leftovers.length > 0) {
      throw new Error(`arrêt incomplet après 5 min (${leftovers.join(", ")}) ; aucun kill -9 envoyé, intervention manuelle requise`);
    }
    log("old server and database stopped");

    // 5. Relaunch, 6. verify; one retry if the new process dies or never gets healthy.
    const serverLogPath = path.join(paths.logsDir, "server.log");
    const launch = () => {
      const fd = fs.openSync(serverLogPath, "a");
      const child = spawn("pnpm", ["paperclipai", "run"], {
        cwd: REPO_ROOT,
        detached: true,
        stdio: ["ignore", fd, fd],
        env: state.relaunchEnv,
      });
      child.unref();
      fs.closeSync(fd);
      log(`relaunched 'pnpm paperclipai run' as pid ${child.pid ?? "?"} (output: ${serverLogPath})`);
      return child.pid ?? null;
    };
    const waitHealthy = async (launcherPid: number | null) => {
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        const health = await fetchHealth(apiBase);
        if (health?.processStartedAt
          && (!state.previousProcessStartedAt || Date.parse(health.processStartedAt) > Date.parse(state.previousProcessStartedAt))) {
          return health;
        }
        if (launcherPid && !isPidAlive(launcherPid)) {
          log(`relaunched process ${launcherPid} exited before becoming healthy`);
          return null;
        }
        await sleep(2_000);
      }
      log("server not healthy after 5 min");
      return null;
    };

    let launcherPid = launch();
    let health = await waitHealthy(launcherPid);
    if (!health) {
      if (launcherPid && isPidAlive(launcherPid)) {
        throw new Error("le serveur relancé tourne mais /api/health ne répond pas après 5 min ; pas de seconde relance (port occupé)");
      }
      log("retrying the relaunch once");
      launcherPid = launch();
      health = await waitHealthy(launcherPid);
      if (!health) throw new Error("le serveur ne revient pas après deux relances");
    }
    outcome.newProcessStartedAt = health.processStartedAt;
    log(`server healthy, processStartedAt ${health.processStartedAt}`);

    // The new server writes the report shortly after /api/health turns ready.
    type HotRestartReportFile = {
      completedAt?: string;
      previousServerPid?: number;
      adoptedRunIds?: string[];
      finalizedWhileDownRunIds?: string[];
      lostRunIds?: string[];
      drainReason?: string | null;
    };
    const isFreshReport = (candidate: HotRestartReportFile | null) => Boolean(candidate?.completedAt
      && candidate.previousServerPid === state.serverPid
      && Date.parse(candidate.completedAt) >= Date.parse(state.startedAt));
    let report = readJson<HotRestartReportFile>(paths.reportPath);
    const reportDeadline = Date.now() + 2 * 60_000;
    while (!isFreshReport(report) && Date.now() < reportDeadline) {
      await sleep(1_000);
      report = readJson<HotRestartReportFile>(paths.reportPath);
    }
    if (report && isFreshReport(report)) {
      outcome.report = {
        adoptedRunIds: report.adoptedRunIds ?? [],
        finalizedWhileDownRunIds: report.finalizedWhileDownRunIds ?? [],
        lostRunIds: report.lostRunIds ?? [],
        drainReason: report.drainReason ?? null,
      };
      log(`hot-restart report: adopted ${outcome.report.adoptedRunIds.length}, finalized ${outcome.report.finalizedWhileDownRunIds.length}, lost ${outcome.report.lostRunIds.length}`);
    } else {
      log(`no fresh hot-restart report at ${paths.reportPath}`);
    }

    const after = await inspectMigrations(resolveDatabase().url);
    if (after.status !== "upToDate") throw new Error(`migrations encore en attente après la relance : ${after.pendingMigrations.join(", ")}`);

    if (outcome.report && outcome.report.lostRunIds.length > 0) {
      outcome.status = "failed";
      outcome.reason = "serveur relancé, mais des runs ont été perdus (échec de continuité)";
    } else {
      outcome.status = "succeeded";
    }
  } catch (error) {
    outcome.status = error instanceof Abort ? "aborted" : "failed";
    outcome.reason = (error as Error).message;
    log(`${outcome.status}: ${outcome.reason}`);
  }

  outcome.finishedAt = new Date().toISOString();
  log(`done: ${outcome.status}`);
  try {
    outcome.logTail = fs.readFileSync(state.logPath, "utf8").trimEnd().split("\n").slice(-40);
  } catch {
    outcome.logTail = [];
  }

  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(paths.lastResultPath, `${JSON.stringify(outcome, null, 2)}\n`);

  let commented = false;
  const serverUp = !serverStopped || outcome.newProcessStartedAt !== null || (await fetchHealth(apiBase)) !== null;
  if (serverUp) {
    try {
      const response = await apiRequest(apiBase, apiKey, `/api/issues/${encodeURIComponent(options.issue)}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: formatOutcomeComment(outcome) }),
      });
      commented = response.ok;
      log(commented ? `commented ${options.issue}` : `comment failed: HTTP ${response.status} ${await response.text()}`);
    } catch (error) {
      log(`comment failed: ${(error as Error).message}`);
    }
  }
  if (!commented || (serverStopped && outcome.status !== "succeeded")) {
    const message = `${outcome.status} : ${outcome.reason ?? "voir le log"} (${paths.lastResultPath})`;
    run("osascript", ["-e", `display notification ${JSON.stringify(message)} with title "Paperclip safe-restart (${options.instanceId})" sound name "Basso"`]);
    log("macOS notification sent");
  }

  const lock = readJson<{ pid?: number }>(paths.lockPath);
  if (lock?.pid === process.pid || lock?.pid === process.ppid) fs.rmSync(paths.lockPath, { force: true });
  process.exit(outcome.status === "succeeded" ? 0 : 1);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--worker") {
    await runWorker();
  } else if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
  } else {
    await runLauncher(argv);
  }
}
