"use client";

/**
 * The form that turns one `pending_user_input` row into a resume request
 * (v1-D). One instance per row, rendered by `QueueClient`. Kept small on
 * purpose: it is a controlled form with a submit button and nothing else, and
 * the row's optimistic disappearance is the parent's business, not this one's.
 *
 * ── Why the payload carries both `topicSlug` and `question` ────────────────
 * v1-B's classifier does not always assign a `topicSlug`: an unknown intent
 * gets escalated so the person can still make the submission move. When that
 * happens the resume endpoint keys the writeback on `question` instead, which
 * means this form has to send both when it has both and just the question when
 * it does not, and never nothing. The payload builder below enforces that.
 *
 * ── v1-BLOCKER-2 (#152): one camelCase shape across the cycle ──────────────
 * The submit body is `{answers: [{topicSlug, question, answer}, ...]}` and the
 * key names match the columns v1-C's `writeEscalation` persists and the reader
 * in `lib/dashboard/queue-data.ts` surfaces. No side of the round trip has to
 * translate between conventions.
 */

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { EscalationQuestion } from "@/lib/dashboard/queue-data";

export type EscalationSubmitPayload = {
  answers: Array<{
    topicSlug: string | null;
    question: string;
    answer: string;
  }>;
};

type Props = {
  applicationId: string;
  questions: EscalationQuestion[];
  /**
   * Called after the answers have been POSTed successfully. Parent uses it to
   * remove the row from the pending list and show a spinner over on the
   * applied side.
   */
  onResolved: (applicationId: string) => void;
};

export function EscalationForm({ applicationId, questions, onResolved }: Props) {
  const [values, setValues] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const payload: EscalationSubmitPayload = { answers: [] };
    for (let i = 0; i < questions.length; i++) {
      const answer = (values[i] ?? "").trim();
      if (!answer) {
        setError("Please answer every question before you submit.");
        return;
      }
      const q = questions[i];
      payload.answers.push({
        topicSlug: q.topicSlug ?? null,
        question: q.question,
        answer,
      });
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/applications/${applicationId}/escalation-answers`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Could not send your answers. Try again in a moment.");
        setSubmitting(false);
        return;
      }
      onResolved(applicationId);
    } catch {
      setError("Could not reach the server. Try again in a moment.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {questions.map((q, i) => {
        const inputId = `q-${applicationId}-${i}`;
        const options = q.options ?? null;
        return (
          <div key={inputId} className="space-y-2">
            <Label htmlFor={inputId} className="block text-sm font-medium">
              {q.question}
            </Label>

            {options && options.length > 0 ? (
              <div className="space-y-1.5">
                {options.map((opt) => {
                  const optionId = `${inputId}-${opt}`;
                  return (
                    <label
                      key={optionId}
                      htmlFor={optionId}
                      className="flex cursor-pointer items-center gap-2 text-sm"
                    >
                      <input
                        id={optionId}
                        type="radio"
                        name={inputId}
                        value={opt}
                        checked={values[i] === opt}
                        onChange={(e) => setValues((v) => ({ ...v, [i]: e.target.value }))}
                        disabled={submitting}
                        className="size-4"
                      />
                      <span>{opt}</span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <Textarea
                id={inputId}
                value={values[i] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [i]: e.target.value }))}
                disabled={submitting}
                rows={3}
                placeholder="Your answer"
              />
            )}
          </div>
        );
      })}

      {error ? (
        <p className="text-sm text-amber-700 dark:text-amber-400" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button type="submit" disabled={submitting}>
          {submitting ? "Sending..." : "Send answers"}
        </Button>
      </div>
    </form>
  );
}
