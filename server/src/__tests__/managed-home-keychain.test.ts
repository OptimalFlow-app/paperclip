import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedManagedHomeKeychain } from "../services/ai-connection-runtime.js";

// show-keychain-info reports on stderr; default-keychain on stdout.
const security = (home: string, ...args: string[]) => {
  const result = spawnSync("security", args, { env: { ...process.env, HOME: home }, encoding: "utf8" });
  return result.stdout + result.stderr;
};
const operatorHome = os.userInfo().homedir;

describe.runIf(process.platform === "darwin")("managed home keychain", () => {
  let home: string;
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it("gives the disposable home its own never-locking default keychain", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-keychain-test-"));
    const keychain = path.join(home, "Library", "Keychains", "login.keychain-db");
    const operatorDefault = security(operatorHome, "default-keychain");
    expect(security(home, "default-keychain")).toContain("could not be found");
    await seedManagedHomeKeychain(home);
    expect(security(home, "default-keychain")).toContain(path.basename(home));
    expect(security(home, "show-keychain-info", keychain)).toContain("no-timeout");
    expect(security(operatorHome, "default-keychain")).toBe(operatorDefault);
  });
});
