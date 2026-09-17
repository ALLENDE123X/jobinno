// JOB-365. Side by side comparison, split down the middle.
export function ManualVsJobinnoSplit() {
  return (
    <div className="grid h-full w-full grid-cols-2">
      <div className="border-white/10 flex flex-col justify-center gap-4 border-r px-16">
        <p className="text-muted-foreground text-2xl">You, on Handshake</p>
        <p className="text-7xl font-semibold">6 apps</p>
        <p className="text-muted-foreground text-2xl">in 3 hours, by hand</p>
      </div>
      <div className="flex flex-col justify-center gap-4 bg-emerald-500/5 px-16">
        <p className="text-2xl text-emerald-400">Jobinno, overnight</p>
        <p className="text-7xl font-semibold text-emerald-400">47 apps</p>
        <p className="text-2xl text-emerald-400">in 6 hours, while you slept</p>
      </div>
    </div>
  );
}
