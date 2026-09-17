// JOB-365. No Grid mascot asset exists in public/ yet, so this uses the
// ticket's own fallback: a placeholder colored circle labeled "GRID",
// composited into a simple laptop scene built from divs.
export function GridMascotWorking() {
  return (
    <div className="flex h-full w-full items-center justify-center gap-20 px-16">
      <div className="flex size-64 items-center justify-center rounded-full bg-sky-500/20 text-4xl font-bold text-sky-400">
        GRID
      </div>
      <div className="flex flex-col items-center gap-2">
        <div className="border-white/10 flex h-56 w-96 flex-col justify-between rounded-t-xl border bg-card p-6">
          <div className="space-y-2">
            <p className="text-muted-foreground text-sm">jobinno.app</p>
            <p className="text-lg font-medium">Filling application: Anthropic</p>
          </div>
          <div className="h-2 w-3/4 rounded-full bg-sky-500/40" />
        </div>
        <div className="h-4 w-[440px] rounded-b-2xl bg-white/10" />
      </div>
    </div>
  );
}
