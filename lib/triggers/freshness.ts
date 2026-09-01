/**
 * A human review/dismissal acknowledges every trigger known at that moment.
 * Once that boundary exists, a trigger is actionable only when both the source
 * event and Stanley's detection happened after the decision. This prevents a
 * late crawl of an old article/award from reheating a lead the AE already handled.
 */
export function triggerIsAfterReviewBoundary(
  trigger: { signal_date?: string | null; detected_at?: string | null },
  reviewedThrough?: string | null,
): boolean {
  if (!reviewedThrough) return true;
  const boundary = Date.parse(reviewedThrough);
  const signal = trigger.signal_date ? Date.parse(trigger.signal_date) : Number.NaN;
  const detected = trigger.detected_at ? Date.parse(trigger.detected_at) : Number.NaN;
  if (!Number.isFinite(boundary) || !Number.isFinite(signal) || !Number.isFinite(detected)) return false;
  return signal > boundary && detected > boundary;
}
