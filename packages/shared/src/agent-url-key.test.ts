import { describe, expect, it } from "vitest";
import { deriveAgentUrlKey, normalizeAgentUrlKey } from "./agent-url-key.js";

describe("normalizeAgentUrlKey", () => {
  it("keeps ASCII names unchanged", () => {
    expect(normalizeAgentUrlKey("CEO")).toBe("ceo");
    expect(normalizeAgentUrlKey("Senior Coder")).toBe("senior-coder");
    expect(normalizeAgentUrlKey("  QA / Release  ")).toBe("qa-release");
  });

  it("transliterates accented letters instead of turning them into separators", () => {
    expect(normalizeAgentUrlKey("Rédacteur notoriété")).toBe("redacteur-notoriete");
    expect(normalizeAgentUrlKey("Señor Diseñador")).toBe("senor-disenador");
    expect(normalizeAgentUrlKey("Ärger Ölmühle")).toBe("arger-olmuhle");
  });

  it("matches the slug a portable package derives for the same agent", () => {
    expect(normalizeAgentUrlKey("Rédacteur conversion")).toBe(normalizeAgentUrlKey("redacteur-conversion"));
  });

  it("still returns null when nothing ASCII survives", () => {
    expect(normalizeAgentUrlKey("编辑")).toBeNull();
    expect(deriveAgentUrlKey("编辑", "writer")).toBe("writer");
  });
});
