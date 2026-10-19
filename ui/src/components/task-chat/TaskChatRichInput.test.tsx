// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeechRecognitionLike } from "@/hooks/useSpeechDictation";
import { TaskChatRichInput } from "./TaskChatRichInput";

vi.mock("@/components/MarkdownEditor", async () => {
  const { forwardRef } = await import("react");
  return {
    MarkdownEditor: forwardRef<unknown, { value: string }>(({ value }, _ref) => (
      <div data-testid="editor-value">{value}</div>
    )),
  };
});

class FakeRecognition implements SpeechRecognitionLike {
  static instances: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: SpeechRecognitionLike["onresult"] = null;
  onerror: SpeechRecognitionLike["onerror"] = null;
  onend: SpeechRecognitionLike["onend"] = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn();
  constructor() {
    FakeRecognition.instances.push(this);
  }
  emit(transcript: string) {
    const result = Object.assign([{ transcript }], { isFinal: true });
    this.onresult?.({ resultIndex: 0, results: [result] });
  }
}

let container: HTMLDivElement;
let root: Root;

describe("TaskChatRichInput dictation", () => {
  beforeEach(() => {
    FakeRecognition.instances = [];
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  });

  it("appends dictated phrases to the answer", () => {
    const onChange = vi.fn();
    flushSync(() =>
      root.render(
        <TaskChatRichInput value="Oui" onChange={onChange} testId="question-other-answer-composer" />,
      ),
    );
    const mic = container.querySelector<HTMLButtonElement>(
      "[data-testid='question-other-answer-composer-dictation']",
    );
    expect(mic).not.toBeNull();

    act(() => mic!.click());
    act(() => FakeRecognition.instances[0].emit("parfait"));
    act(() => FakeRecognition.instances[0].emit("merci"));
    expect(onChange).toHaveBeenNthCalledWith(1, "Oui parfait");
    expect(onChange).toHaveBeenNthCalledWith(2, "Oui parfait merci");
  });
});
