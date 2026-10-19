import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Browser speech-to-text for prompt composers.
 *
 * Wraps the Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`),
 * available in Chromium browsers and Safari. Recognition runs in the browser,
 * so no server endpoint is involved. Only *final* phrases are handed to
 * `onFinalText`; the in-progress phrase is exposed as `interim` for display.
 */

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const candidate = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition ?? null;
}

/** Joins a dictated phrase onto existing text with a single separating space. */
export function appendDictatedText(current: string, dictated: string): string {
  const text = dictated.trim();
  if (!text) return current;
  if (!current || /\s$/.test(current)) return `${current}${text}`;
  return `${current} ${text}`;
}

function describeSpeechError(code: string): string | null {
  switch (code) {
    case "no-speech":
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was denied. Allow it in your browser settings to dictate.";
    case "audio-capture":
      return "No microphone was found.";
    case "network":
      return "Speech recognition needs a network connection.";
    default:
      return "Speech recognition stopped unexpectedly.";
  }
}

export interface UseSpeechDictationOptions {
  onFinalText: (text: string) => void;
  /** BCP-47 language tag; defaults to the browser language. */
  lang?: string;
}

export function useSpeechDictation({ onFinalText, lang }: UseSpeechDictationOptions) {
  const [supported] = useState(() => getSpeechRecognitionConstructor() !== null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onFinalTextRef = useRef(onFinalText);
  onFinalTextRef.current = onFinalText;

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition || recognitionRef.current) return;
    const recognition = new Recognition();
    recognition.lang = lang ?? navigator.language ?? "";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let pending = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) onFinalTextRef.current(transcript);
        else pending += transcript;
      }
      setInterim(pending.trim());
    };
    recognition.onerror = (event) => {
      const message = describeSpeechError(event.error);
      if (message) setError(message);
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      setListening(false);
      setInterim("");
    };
    recognitionRef.current = recognition;
    setError(null);
    setInterim("");
    try {
      recognition.start();
      setListening(true);
    } catch {
      recognitionRef.current = null;
      setError("Speech recognition could not start.");
    }
  }, [lang]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(timer);
  }, [error]);

  const toggle = useCallback(() => {
    if (recognitionRef.current) stop();
    else start();
  }, [start, stop]);

  useEffect(() => () => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    recognitionRef.current = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    recognition.abort();
  }, []);

  return { supported, listening, interim, error, start, stop, toggle };
}
