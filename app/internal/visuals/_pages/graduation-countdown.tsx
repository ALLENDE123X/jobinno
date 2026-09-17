// JOB-365. Countdown banner over a progress bar toward 500 applications.
const DAYS_LEFT = 184;
const SUBMITTED = 214;
const TARGET = 500;

export function GraduationCountdown() {
  const percent = Math.round((SUBMITTED / TARGET) * 100);
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center justify-center bg-sky-500/10 py-8">
        <p className="text-3xl font-semibold text-sky-400">
          {DAYS_LEFT} days until you graduate
        </p>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-16">
        <p className="text-muted-foreground text-2xl">Progress toward 500 applications</p>
        <p className="text-7xl font-semibold">
          {SUBMITTED} / {TARGET}
        </p>
        <div className="h-4 w-[900px] overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${percent}%` }} />
        </div>
      </div>
    </div>
  );
}
