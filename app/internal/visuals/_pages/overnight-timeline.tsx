// JOB-365. 12 hours of activity. Landscape layout: three vertical timeline
// columns, one per four hour block, arranged left to right rather than one
// long column, so the frame's width does the work instead of its height.
const COLUMNS = [
  {
    label: "11pm to 3am",
    entries: [
      "11:52pm: submitted to Ramp",
      "12:14am: filling Anthropic",
      "12:41am: submitted to Anthropic",
      "1:20am: filling Vercel",
      "1:55am: submitted to Vercel",
      "2:30am: filling Notion",
    ],
  },
  {
    label: "3am to 7am",
    entries: [
      "3:04am: submitted to Notion",
      "3:48am: filling Linear",
      "4:22am: submitted to Linear",
      "5:10am: filling Stripe",
      "5:47am: submitted to Stripe",
      "6:35am: filling Rippling",
    ],
  },
  {
    label: "7am to 11am",
    entries: [
      "7:03am: submitted to Rippling",
      "7:41am: filling Brex",
      "8:12am: submitted to Brex",
      "8:47am: submitted to Figma",
      "9:30am: filling Plaid",
      "10:15am: submitted to Plaid",
    ],
  },
];

export function OvernightTimeline() {
  return (
    <div className="flex h-full w-full flex-col gap-10 px-16 py-14">
      <h1 className="text-3xl font-semibold tracking-tight">Overnight activity</h1>
      <div className="grid grid-cols-3 gap-12">
        {COLUMNS.map((column) => (
          <div key={column.label} className="border-white/10 flex flex-col gap-5 border-l pl-6">
            <p className="text-muted-foreground text-sm tracking-wide uppercase">
              {column.label}
            </p>
            {column.entries.map((entry) => (
              <p key={entry} className="text-lg">
                {entry}
              </p>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
