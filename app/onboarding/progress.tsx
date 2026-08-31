/**
 * Horizontal progress indicator for the multi-page onboarding flow.
 *
 * No prose hyphens or em dashes per HARD STOP 8 in CLAUDE.md.
 */

export function OnboardingProgress({
  currentStep,
  totalSteps = 5,
}: {
  currentStep: number;
  totalSteps?: number;
}) {
  const pct = Math.round((currentStep / totalSteps) * 100);

  return (
    <div className="mb-6 space-y-2">
      <p className="text-muted-foreground text-xs">
        Step {currentStep} of {totalSteps}
      </p>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
