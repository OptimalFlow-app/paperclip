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
