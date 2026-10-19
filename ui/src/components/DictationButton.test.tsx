// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictationButton } from "./DictationButton";
import { appendDictatedText, type SpeechRecognitionLike } from "@/hooks/useSpeechDictation";

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
  emit(transcript: string, isFinal: boolean) {
    const result = Object.assign([{ transcript }], { isFinal });
    this.onresult?.({ resultIndex: 0, results: [result] });
  }
}

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode) {
  flushSync(() => root.render(node));
}

function button() {
  return container.querySelector<HTMLButtonElement>("[data-testid='composer-dictation']");
}

describe("appendDictatedText", () => {
  it("joins phrases with a single space", () => {
    expect(appendDictatedText("", " bonjour ")).toBe("bonjour");
    expect(appendDictatedText("bonjour", "le monde")).toBe("bonjour le monde");
    expect(appendDictatedText("ligne\n", "suite")).toBe("ligne\nsuite");
    expect(appendDictatedText("texte", "   ")).toBe("texte");
  });
});

describe("DictationButton", () => {
  beforeEach(() => {
    FakeRecognition.instances = [];
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  });

  it("shows a disabled button when the browser lacks speech recognition", () => {
    render(<DictationButton onText={() => {}} />);
    expect(button()?.disabled).toBe(true);
    expect(button()?.dataset.unsupported).toBe("true");
    expect(button()?.title).toMatch(/isn't available in this browser/);
  });

  it("streams final phrases to onText and stops on second click", () => {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    const onText = vi.fn();
    render(<DictationButton onText={onText} />);

    act(() => button()!.click());
    const recognition = FakeRecognition.instances[0];
    expect(recognition.start).toHaveBeenCalled();
    expect(recognition.continuous).toBe(true);
    expect(button()!.getAttribute("aria-pressed")).toBe("true");

    act(() => recognition.emit("bonj", false));
    expect(container.textContent).toContain("bonj");
    expect(onText).not.toHaveBeenCalled();

    act(() => recognition.emit("bonjour", true));
    expect(onText).toHaveBeenCalledWith("bonjour");

    act(() => button()!.click());
    expect(recognition.stop).toHaveBeenCalled();
    expect(button()!.getAttribute("aria-pressed")).toBe("false");
  });

  it("surfaces a denied microphone permission", () => {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    render(<DictationButton onText={() => {}} />);
    act(() => button()!.click());
    act(() => {
      FakeRecognition.instances[0].onerror?.({ error: "not-allowed" });
      FakeRecognition.instances[0].onend?.();
    });
    expect(container.querySelector("[role='alert']")?.textContent).toContain("denied");
  });

  it("dictates in the chosen language and remembers it", () => {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    window.localStorage.setItem("paperclip.dictation.lang", "en-US");
    render(<DictationButton onText={() => {}} />);
    const langButton = () => container.querySelector<HTMLButtonElement>("[data-testid='composer-dictation-lang']")!;
    expect(langButton().textContent).toBe("EN");

    act(() => langButton().click());
    expect(langButton().textContent).toBe("FR");
    expect(window.localStorage.getItem("paperclip.dictation.lang")).toBe("fr-FR");

    act(() => button()!.click());
    expect(FakeRecognition.instances[0].lang).toBe("fr-FR");
  });
});
