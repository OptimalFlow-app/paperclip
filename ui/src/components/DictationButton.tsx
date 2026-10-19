import { useEffect } from "react";
import { Mic, MicOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSpeechDictation } from "@/hooks/useSpeechDictation";

interface DictationButtonProps {
  /** Receives each finalized dictated phrase. */
  onText: (text: string) => void;
  disabled?: boolean;
  className?: string;
  testId?: string;
}

/**
 * Microphone toggle for prompt composers. Renders nothing when the browser has
 * no speech recognition, so composers can mount it unconditionally. While
 * listening, the in-progress phrase floats above the button.
 */
export function DictationButton({
  onText,
  disabled = false,
  className,
  testId = "composer-dictation",
}: DictationButtonProps) {
  const { supported, listening, interim, error, stop, toggle } = useSpeechDictation({
    onFinalText: onText,
  });

  useEffect(() => {
    if (disabled && listening) stop();
  }, [disabled, listening, stop]);

  if (!supported) return null;

  const label = listening ? "Stop dictation" : "Dictate with microphone";
  const bubble = error ?? (listening ? interim || "Listening…" : null);

  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
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
