// JOB-365. Inbox mock: 3 offers highlighted above 12 ordinary rejections.
const OFFERS = [
  { company: "Anthropic", subject: "Offer: Software Engineer, New Grad" },
  { company: "Ramp", subject: "You are getting an offer from Ramp" },
  { company: "Vercel", subject: "Vercel offer, next steps inside" },
];

const REJECTIONS = [
  "Stripe", "Notion", "Linear", "Brex", "Plaid", "Retool", "Segment",
  "Okta", "Datadog", "Snowflake", "Webflow", "Discord",
];

export function OfferEmailInbox() {
  return (
    <div className="flex h-full w-full gap-10 px-16 py-14">
      <div className="flex w-[720px] flex-col gap-3">
        <h1 className="mb-2 text-3xl font-semibold tracking-tight">Inbox</h1>
        {OFFERS.map((offer) => (
          <div
            key={offer.company}
            className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-5 py-4"
          >
            <p className="text-sm font-medium text-emerald-400">{offer.company}</p>
            <p className="text-lg font-medium">{offer.subject}</p>
          </div>
        ))}
        {REJECTIONS.slice(0, 6).map((company) => (
          <div key={company} className="border-white/5 rounded-xl border px-5 py-3">
            <p className="text-muted-foreground text-sm">{company}</p>
            <p className="text-muted-foreground">Update on your application</p>
          </div>
        ))}
      </div>
      <div className="flex flex-1 flex-col justify-center gap-4">
        <p className="text-muted-foreground text-2xl">Across 15 applications this week</p>
        <p className="text-8xl font-semibold">3 offers</p>
        <p className="text-muted-foreground text-2xl">
          and {REJECTIONS.length} rejections, all read while you kept applying
        </p>
      </div>
    </div>
  );
}
