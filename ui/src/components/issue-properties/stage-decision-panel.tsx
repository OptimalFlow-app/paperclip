import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { buildStageDecisionPatch, type IssueStageDecisionStatus } from "../../lib/issue-stage-decision";

interface StageDecisionPanelProps {
  issue: Issue;
  /** Selected decision; `null` keeps the form collapsed to the two choices. */
  decision: IssueStageDecisionStatus | null;
  onDecisionChange: (decision: IssueStageDecisionStatus | null) => void;
}

/**
 * Decision form for the user the active review/approval stage is waiting on.
 * The server only records the verdict when the status change and the decision
 * comment arrive in the same PATCH, so this sends exactly one
 * `{ status, comment }` update and keeps the assignee untouched — the
 * execution policy routes the issue to the next stage or back to the
 * return assignee.
 */
export function StageDecisionPanel({ issue, decision, onDecisionChange }: StageDecisionPanelProps) {
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stageLabel = issue.executionState?.currentStageType === "review" ? "review" : "approval";

  useEffect(() => {
    if (decision) textareaRef.current?.focus();
  }, [decision]);

  const submitDecision = useMutation({
    mutationFn: (data: { status: IssueStageDecisionStatus; comment: string }) =>
      issuesApi.update(issue.id, buildStageDecisionPatch(data.status, data.comment)),
    onSuccess: () => {
      setComment("");
      onDecisionChange(null);
      for (const ref of [issue.id, issue.identifier]) {
        if (!ref) continue;
        void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(ref) });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issue.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issue.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(issue.companyId) });
    },
  });

  const trimmedComment = comment.trim();
  const errorMessage = submitDecision.error instanceof Error
    ? submitDecision.error.message
    : submitDecision.error
      ? "Unable to record the decision"
      : null;

  const choose = (next: IssueStageDecisionStatus) => {
    submitDecision.reset();
    onDecisionChange(decision === next ? null : next);
  };

  return (
    <div className="space-y-2 rounded-md border border-border p-2" data-testid="stage-decision-panel">
      <div className="text-xs font-medium text-foreground">Your {stageLabel} is requested</div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          className="h-7 text-xs"
          variant={decision === "done" ? "default" : "outline"}
          aria-pressed={decision === "done"}
          onClick={() => choose("done")}
        >
          Approve
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-7 text-xs"
          variant={decision === "in_progress" ? "default" : "outline"}
          aria-pressed={decision === "in_progress"}
          onClick={() => choose("in_progress")}
        >
          Request changes
        </Button>
      </div>
      {decision ? (
        <>
          <Textarea
            ref={textareaRef}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder={decision === "done"
              ? "Why are you approving? (required)"
              : "What needs to change? (required)"}
            aria-label="Decision comment"
            rows={3}
            className="text-xs"
          />
          {errorMessage ? (
            <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
              {errorMessage}
            </div>
          ) : null}
          <div className="flex items-center justify-between">
            <button
              type="button"
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => {
                submitDecision.reset();
                onDecisionChange(null);
              }}
            >
              Cancel
            </button>
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={!trimmedComment || submitDecision.isPending}
              onClick={() => submitDecision.mutate({ status: decision, comment: trimmedComment })}
            >
              {submitDecision.isPending
                ? "Sending…"
                : decision === "done" ? "Confirm approval" : "Send back for changes"}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
