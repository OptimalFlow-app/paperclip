// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
const api = vi.hoisted(() => ({ getIssue: vi.fn(), getProject: vi.fn(), setVisibility: vi.fn(),
  members: vi.fn(), add: vi.fn(), remove: vi.fn(), directory: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: { get: api.getIssue, setVisibility: api.setVisibility } }));
vi.mock("@/api/projects", () => ({ projectsApi: { get: api.getProject, listAccessMembers: api.members,
  addAccessMember: api.add, removeAccessMember: api.remove } }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: api.directory } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: () => Promise.resolve([]) } }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
import { IssuePrivacyActions } from "./IssuePrivacyActions";
import { ProjectAccessMembers } from "./ProjectAccessMembers";
import type { Project } from "@paperclipai/shared";
async function settle() {
  for (let i = 0; i < 8; i++) { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {}); }
}
const originalScrollIntoView = Element.prototype.scrollIntoView;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    Element.prototype.scrollIntoView = () => {};
  vi.resetAllMocks();
  api.directory.mockResolvedValue({ users: [] });
  api.members.mockResolvedValue([]);
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { flushSync(() => root.unmount()); client.clear(); document.body.innerHTML = "";
    vi.unstubAllGlobals();
    Element.prototype.scrollIntoView = originalScrollIntoView; });
function render(node: React.ReactNode) { flushSync(() => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)); }
function publicButton() { return [...document.body.querySelectorAll("button")].find(b => b.textContent?.trim() === "Make public")!; }
function actions(scope: { privacyParentIssueId?: string; projectId?: string } = {}) {
  render(<IssuePrivacyActions issue={{ id: "child", visibility: "private", identifier: "PAP-1", ...scope }} companyId="company" canManage closeMenu={() => {}}>{items => <div>{items}</div>}</IssuePrivacyActions>);
}
describe("inherited privacy controls", () => {
  it("blocks a private parent and does not send an impossible visibility change", async () => {
    api.getIssue.mockResolvedValue({ visibility: "private" });
    actions({ privacyParentIssueId: "parent" }); await settle();
    expect(publicButton().disabled).toBe(true);
    publicButton().click(); expect(api.setVisibility).not.toHaveBeenCalled();
  });
  it("blocks a non-personal private project but permits leaving a personal project", async () => {
    api.getProject.mockResolvedValue({ visibility: "private", personalOwnerUserId: null });
    actions({ projectId: "project" }); await settle(); expect(publicButton().disabled).toBe(true);
    api.getProject.mockResolvedValue({ visibility: "private", personalOwnerUserId: "owner" });
    await client.invalidateQueries({ queryKey: queryKeys.projects.detail("project") }); await settle();
    expect(publicButton().disabled).toBe(false);
  });
  it("checks a parent's private project even when the parent itself is open", async () => {
    api.getIssue.mockResolvedValue({ visibility: "open", projectId: "project" });
    api.getProject.mockResolvedValue({ visibility: "private" });
    actions({ privacyParentIssueId: "parent" }); await settle(); expect(publicButton().disabled).toBe(true);
  });
  it("permits making a child public after its parent is open", async () => {
    api.getIssue.mockResolvedValue({ visibility: "open" });
    actions({ privacyParentIssueId: "parent" }); await settle(); expect(publicButton().disabled).toBe(false);
  });
  it("keeps unresolved and failed scope checks closed, and retries in place", async () => {
    let reject!: (error: Error) => void;
    api.getIssue.mockReturnValue(new Promise((_resolve, rejectFn) => { reject = rejectFn; }));
    actions({ privacyParentIssueId: "parent" }); await settle(); expect(publicButton().disabled).toBe(true);
    reject(new Error("Unavailable")); await settle(); expect(publicButton().disabled).toBe(true);
    api.getIssue.mockResolvedValue({ visibility: "open" });
    flushSync(() => [...document.body.querySelectorAll("button")].find(b => b.textContent === "Retry access check")!.click());
    await settle(); expect(publicButton().disabled).toBe(false);
  });
});
it("invalidates cached task audience when project membership is removed", async () => {
  const key = queryKeys.issues.accessGrants("child");
  client.setQueryData(key, [{ subjectId: "member", source: "project" }]);
  api.members.mockResolvedValue([{ id: "m1", subjectType: "user", subjectId: "member", subjectDisplayName: "Morgan" }]);
  api.remove.mockResolvedValue({});
  render(<ProjectAccessMembers project={{ id: "project", companyId: "company" } as Project} canManage />);
  flushSync(() => [...document.body.querySelectorAll("button")].find(b => b.textContent?.includes("Manage access"))!.click());
  await settle();
  flushSync(() => (document.body.querySelector('[aria-label="Remove Morgan"]') as HTMLButtonElement).click());
  await settle();
  expect(api.remove).toHaveBeenCalledWith("project", "m1", "company");
  expect(client.getQueryState(key)?.isInvalidated).toBe(true);
});
