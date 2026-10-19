import { useEffect } from "react";
import { Mic, MicOff } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getDictationLanguages,
  useDictationLanguage,
  useSpeechDictation,
} from "@/hooks/useSpeechDictation";

interface DictationButtonProps {
  /** Receives each finalized dictated phrase. */
  onText: (text: string) => void;
  disabled?: boolean;
  className?: string;
  testId?: string;
}

/**
 * Microphone toggle for prompt composers. When the browser has no speech
 * recognition (e.g. Firefox) it stays visible but disabled, with a tooltip
 * explaining why. While listening, the in-progress phrase floats above it.
 */
export function DictationButton({
  onText,
  disabled = false,
  className,
  testId = "composer-dictation",
}: DictationButtonProps) {
  const [lang, setLang] = useDictationLanguage();
  const { supported, listening, interim, error, stop, toggle } = useSpeechDictation({
    onFinalText: onText,
    lang,
  });

  // Recognition reads its language at start, so switching mid-session stops it.
  const cycleLang = () => {
    if (listening) stop();
    const langs = getDictationLanguages();
    const index = langs.findIndex((tag) => tag.toLowerCase() === lang.toLowerCase());
    setLang(langs[(index + 1) % langs.length]);
  };
  const shortLang = (lang.split("-")[0] || "?").toUpperCase();

  useEffect(() => {
    if (disabled && listening) stop();
  }, [disabled, listening, stop]);

  const label = !supported
    ? "Voice dictation isn't available in this browser (use Chrome, Edge or Safari)"
    : listening
      ? "Stop dictation"
      : "Dictate with microphone";
  const bubble = error ?? (listening ? interim || "Listening…" : null);

  return (
    // Disabled buttons don't show tooltips in every browser; the wrapper does.
    <span className="relative inline-flex shrink-0 items-center" title={supported ? undefined : label}>
      {supported ? (
        <button
          type="button"
          onClick={cycleLang}
          disabled={disabled}
          aria-label={`Dictation language: ${lang}. Click to change`}
          title={`Dictation language: ${lang} (click to change)`}
          data-testid={`${testId}-lang`}
          className="h-6 shrink-0 rounded px-1 text-[10px] font-medium tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {shortLang}
        </button>
      ) : null}
      <button
        type="button"
        onClick={toggle}
        disabled={disabled || !supported}
        data-unsupported={supported ? undefined : "true"}
        aria-label={label}
        aria-pressed={listening}
        title={label}
        data-testid={testId}
        data-listening={listening ? "true" : undefined}
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
          listening && "bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive",
          className,
        )}
      >
        {listening ? (
          <span className="relative grid place-items-center">
            <span aria-hidden className="absolute size-5 animate-ping rounded-full bg-destructive/25" />
            <MicOff className="relative h-4 w-4" aria-hidden />
          </span>
        ) : (
          <Mic className="h-4 w-4" aria-hidden />
        )}
      </button>
      {bubble ? (
        <span
          role={error ? "alert" : "status"}
          aria-live="polite"
          data-testid={`${testId}-status`}
          className={cn(
            "pointer-events-none absolute right-0 bottom-full z-30 mb-2 w-max max-w-64 rounded-md border bg-popover px-2 py-1 text-xs shadow-md",
            error ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {bubble}
        </span>
      ) : null}
    </span>
  );
}
