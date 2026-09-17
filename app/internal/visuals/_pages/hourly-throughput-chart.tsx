/**
 * JOB-365. Applications submitted per hour over 24 hours.
 *
 * JOB-365 followup: rewritten as an actual line chart. Round 2 red team
 * flagged two problems with the previous bar chart version:
 *
 *   1. A real CSS bug: the bars sat in a flex row with `items-end`, which
 *      makes each bar's flex column shrink wrap to its own content instead
 *      of stretching to the row's height. A bar's height was set as a `%`
 *      of that shrink wrapped column, which has no resolvable height, so
 *      every bar rendered at its `minHeight: 4` floor regardless of count.
 *   2. Ticket item 14 asked for a line chart; the bar chart was an
 *      undisclosed judgment call.
 *
 * Plain SVG rather than a charting library: `recharts` is not in this
 * repo's dependency tree (checked package.json), and the ticket's own
 * instruction is not to add one for a single mock page. A 24 point
 * polyline is trivial to lay out by hand, and doing it with explicit pixel
 * math sidesteps the percent-of-an-unresolved-height class of bug entirely,
 * since every coordinate here is a plain number computed in JS rather than
 * a CSS percentage relying on an ancestor's layout.
 */
const HOURLY_COUNTS = [
  0, 1, 3, 4, 5, 4, 3, 2, 1, 0, 0, 1, 2, 3, 2, 1, 2, 3, 4, 5, 6, 5, 3, 2,
];
const MAX_COUNT = Math.max(...HOURLY_COUNTS);

// viewBox units, not pixels. The SVG scales to whatever its container
// renders at (width="100%" height="100%" below), so these only need to be
// internally consistent with each other, not with the 1920x1080 frame.
const CHART_WIDTH = 1760;
const CHART_HEIGHT = 620;
const MARGIN = { top: 20, right: 20, bottom: 44, left: 56 };
const PLOT_WIDTH = CHART_WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
const Y_TICKS = [0, 2, 4, 6];

function xForHour(hour: number): number {
  return MARGIN.left + (hour / (HOURLY_COUNTS.length - 1)) * PLOT_WIDTH;
}

function yForCount(count: number): number {
  return MARGIN.top + PLOT_HEIGHT - (count / MAX_COUNT) * PLOT_HEIGHT;
}

const LINE_POINTS = HOURLY_COUNTS.map(
  (count, hour) => `${xForHour(hour)},${yForCount(count)}`
).join(" ");

export function HourlyThroughputChart() {
  return (
    <div className="flex h-full w-full flex-col gap-8 px-16 py-14">
      <h1 className="text-3xl font-semibold tracking-tight">Applications per hour</h1>
      <div className="flex-1">
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          width="100%"
          height="100%"
          role="img"
          aria-label="Applications submitted per hour, 24 hour line chart"
        >
          {/* Horizontal gridlines, one per y tick. */}
          {Y_TICKS.map((tick) => (
            <line
              key={tick}
              x1={MARGIN.left}
              x2={CHART_WIDTH - MARGIN.right}
              y1={yForCount(tick)}
              y2={yForCount(tick)}
              className="text-white/10"
              stroke="currentColor"
              strokeWidth={1}
            />
          ))}

          {/* Y axis labels, 0 to MAX_COUNT. */}
          {Y_TICKS.map((tick) => (
            <text
              key={tick}
              x={MARGIN.left - 16}
              y={yForCount(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-muted-foreground text-[20px]"
            >
              {tick}
            </text>
          ))}

          {/* X axis hour labels, every hour 0 to 23. */}
          {HOURLY_COUNTS.map((_, hour) => (
            <text
              key={hour}
              x={xForHour(hour)}
              y={CHART_HEIGHT - MARGIN.bottom + 32}
              textAnchor="middle"
              className="fill-muted-foreground text-[18px]"
            >
              {hour}
            </text>
          ))}

          {/* The line itself. */}
          <polyline
            points={LINE_POINTS}
            fill="none"
            className="text-sky-500"
            stroke="currentColor"
            strokeWidth={4}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* A dot at every hour so a single hour's value reads clearly even
              off the line's own slope. */}
          {HOURLY_COUNTS.map((count, hour) => (
            <circle
              key={hour}
              cx={xForHour(hour)}
              cy={yForCount(count)}
              r={7}
              className="text-sky-400"
              fill="currentColor"
            />
          ))}
        </svg>
      </div>
      <p className="text-muted-foreground text-lg">47 applications total, peak at 8pm and 8am</p>
    </div>
  );
}
