// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createPrivacyState, installPrivacyApi, privacyCompanyId } from "./privateTasks";
describe("private task creation preview", () => {
  it.each([
    [{ title: "Open task" }, "open"],
    [{ title: "Private task", visibility: "private" }, "private"],
    [{ title: "Private child", parentId: "privacy-root" }, "private"],
    [{ title: "Private project task", projectId: "project-private" }, "private"],
  ])("matches creation defaults for %j", async (data, visibility) => {
    const restore = installPrivacyApi(createPrivacyState({}));
    try {
      const response = await fetch(`/api/companies/${privacyCompanyId}/issues`, { method: "POST", body: JSON.stringify(data) });
      expect((await response.json()).visibility).toBe(visibility);
    } finally { restore(); }
  });
});
