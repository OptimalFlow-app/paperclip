// @vitest-environment jsdom

import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SidePanelLayoutProvider,
  useWideMarginsTarget,
  useWideMarginsTargetCount,
} from "./side-panel-layout";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Target({ active }: { active: boolean }) {
  const wide = useWideMarginsTarget(active);
  return <span data-testid="target">{wide ? "wide" : "standard"}</span>;
}

function Host({ maximized, wide, targets }: { maximized: boolean; wide: boolean; targets: boolean[] }) {
  const [count, register] = useWideMarginsTargetCount();
  const value = useMemo(
    () => ({ maximized, wideMargins: maximized && wide, registerWideMarginsTarget: register }),
    [maximized, wide, register],
  );
  return (
    <SidePanelLayoutProvider value={value}>
      <output>{count}</output>
      {targets.map((active, index) => <Target key={index} active={active} />)}
    </SidePanelLayoutProvider>
  );
}

describe("side-panel layout context", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const count = () => container.querySelector("output")?.textContent;
  const states = () => Array.from(container.querySelectorAll("[data-testid=target]")).map((node) => node.textContent);

  it("counts only active targets and releases them on unmount or deactivation", async () => {
    await act(async () => root.render(<Host maximized wide targets={[true, false]} />));
    expect(count()).toBe("1");
    await act(async () => root.render(<Host maximized wide targets={[false, false]} />));
    expect(count()).toBe("0");
    await act(async () => root.render(<Host maximized wide targets={[true, true]} />));
    expect(count()).toBe("2");
    await act(async () => root.render(<Host maximized wide targets={[]} />));
    expect(count()).toBe("0");
  });

  it("applies wide margins only to active targets while maximized", async () => {
    await act(async () => root.render(<Host maximized={false} wide targets={[true]} />));
    expect(states()).toEqual(["standard"]);
    await act(async () => root.render(<Host maximized wide targets={[true, false]} />));
    expect(states()).toEqual(["wide", "standard"]);
  });

  it("is inert outside a host", async () => {
    await act(async () => root.render(<Target active />));
    expect(states()).toEqual(["standard"]);
  });
});
