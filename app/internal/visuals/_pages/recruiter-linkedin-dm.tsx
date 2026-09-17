// JOB-365. A LinkedIn style direct message mock, text based only, no
// LinkedIn asset reused (the LinkedIn brand is not ours to reuse).
export function RecruiterLinkedinDm() {
  return (
    <div className="flex h-full w-full items-center justify-center px-16">
      <div className="w-[900px] rounded-2xl border border-white/10 bg-card p-8">
        <div className="mb-6 flex items-center gap-4">
          <div className="flex size-14 items-center justify-center rounded-full bg-sky-500/20 text-xl font-semibold text-sky-400">
            SK
          </div>
          <div>
            <p className="text-xl font-semibold">Sarah Kim</p>
            <p className="text-muted-foreground text-sm">
              Technical Recruiter at Anthropic
            </p>
          </div>
        </div>
        <div className="bg-muted w-fit max-w-[640px] rounded-2xl rounded-tl-sm px-5 py-4 text-lg">
          hey, saw your resume come through our Greenhouse, would love to chat
          this week
        </div>
        <p className="text-muted-foreground mt-3 text-sm">9:14am</p>
      </div>
    </div>
  );
}
