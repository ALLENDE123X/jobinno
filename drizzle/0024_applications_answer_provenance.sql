-- JOB-170 Change 3. The audit trail for the LLM fabrication rung.
--
-- One jsonb array per application row, each entry shaped as
-- {field_key, field_label, question_text, answered_value, source,
-- model_confidence?} and written by the fill pipeline when a field was
-- answered by the fabrication rung (source "llm_fabrication") or its sane
-- default fallback (source "sane_default"). Null for a run that fabricated
-- nothing. See the column comment in lib/db/schema.ts and the entry type
-- AnswerProvenanceEntry in lib/candidate-answers.ts.
--
-- Additive only: a nullable column with no default, no backfill, no index.
-- No grant accompanies it, for the reason the escalation columns in 0013
-- were granted none: there is no user-side UPDATE policy on this table, the
-- pipeline writes it with the service role, and this is our record about an
-- application rather than an answer the person gives about themselves.
--
-- Hand written rather than generated, same as 0003, 0011, 0021 and 0023,
-- with the journal entry appended to match.

ALTER TABLE public.applications ADD COLUMN answer_provenance jsonb;
