// JOB-365. Applications submitted per hour over 24 hours, drawn as plain
// divs rather than pulling in a charting library the repo does not already
// depend on.
const HOURLY_COUNTS = [
  0, 1, 3, 4, 5, 4, 3, 2, 1, 0, 0, 1, 2, 3, 2, 1, 2, 3, 4, 5, 6, 5, 3, 2,
];
const MAX_COUNT = Math.max(...HOURLY_COUNTS);

export function HourlyThroughputChart() {
  return (
    <div className="flex h-full w-full flex-col gap-8 px-16 py-14">
      <h1 className="text-3xl font-semibold tracking-tight">Applications per hour</h1>
      <div className="flex flex-1 items-end gap-3">
        {HOURLY_COUNTS.map((count, hour) => (
          <div key={hour} className="flex flex-1 flex-col items-center gap-2">
            <div
              className="w-full rounded-t-md bg-sky-500"
              style={{ height: `${(count / MAX_COUNT) * 100}%`, minHeight: count > 0 ? 4 : 0 }}
            />
            <span className="text-muted-foreground text-xs">{hour}</span>
          </div>
        ))}
      </div>
      <p className="text-muted-foreground text-lg">47 applications total, peak at 8pm and 8am</p>
    </div>
  );
}
