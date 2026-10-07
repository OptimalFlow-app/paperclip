// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createPrivacyState, installPrivacyApi, privacyCompanyId } from "./privateTasks";
describe("private task creation preview", () => {
  it.each([
    [{ title: "Open task" }, "open", null, null],
    [{ title: "Private task", visibility: "private" }, "private", "privacy-created", null],
    [{ title: "Private child", parentId: "privacy-root" }, "private", "privacy-root", "privacy-root"],
    [{ title: "Private project task", projectId: "project-private" }, "private", "privacy-created", null],
  ])("matches creation defaults for %j", async (data, visibility, privacyRootIssueId, privacyParentIssueId) => {
    const restore = installPrivacyApi(createPrivacyState({}));
    try {
      const response = await fetch(`/api/companies/${privacyCompanyId}/issues`, { method: "POST", body: JSON.stringify(data) });
      const task = await response.json();
      expect(task).toMatchObject({ visibility, privacyRootIssueId, privacyParentIssueId });
    } finally { restore(); }
  });
});

describe("task privacy moves in the preview", () => {
  it.each([
    [{ projectId: "project-private" }, "privacy-root", "privacy-root", null],
    [{ parentId: "privacy-child" }, "privacy-root", "privacy-root", "privacy-child"],
  ])("inherits privacy when moving an open task into %j", async (data, id, root, parent) => {
    const restore = installPrivacyApi(createPrivacyState({ visibility: "open" }));
    try {
      const response = await fetch(`/api/issues/${id}`, { method: "PATCH", body: JSON.stringify(data) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ visibility: "private", privacyRootIssueId: root, privacyParentIssueId: parent });
    } finally { restore(); }
  });
  it("inherits a parent's private project even if the parent is open", async () => {
    const state = createPrivacyState({ visibility: "open", taskProject: true });
    const restore = installPrivacyApi(state);
    try {
      const response = await fetch("/api/issues/privacy-sibling", { method: "PATCH", body: JSON.stringify({ parentId: "privacy-root" }) });
      expect(await response.json()).toMatchObject({ visibility: "private", privacyRootIssueId: "privacy-root", privacyParentIssueId: "privacy-root" });
    } finally { restore(); }
  });
  it("rejects publishing under a private project without mutating its scope", async () => {
    const state = createPrivacyState({ taskProject: true }); const restore = installPrivacyApi(state);
    try {
      const response = await fetch("/api/issues/privacy-root", { method: "PATCH", body: JSON.stringify({ visibility: "open" }) });
      expect(response.status).toBe(422);
      expect(state.tasks[0]).toMatchObject({ visibility: "private", projectId: "project-private" });
    } finally { restore(); }
  });
  it("leaves a personal project when making its task public", async () => {
    const restore = installPrivacyApi(createPrivacyState({ taskProject: true, personal: true }));
    try {
      const response = await fetch("/api/issues/privacy-root", { method: "PATCH", body: JSON.stringify({ visibility: "open" }) });
      expect(await response.json()).toMatchObject({ visibility: "open", projectId: null, project: null });
    } finally { restore(); }
  });
});
