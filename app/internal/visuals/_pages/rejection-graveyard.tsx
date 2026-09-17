// JOB-365. A grid of tiny muted company tiles standing in for logos (text
// based, per the ticket's fallback for company marks not already in
// public/), with one real offer bright green in the middle of the field.
import { cn } from "@/lib/utils";

import { REAL_COMPANIES } from "../_lib/mock-data";

const TILE_COUNT = 216;
const OFFER_INDEX = 130;

export function RejectionGraveyard() {
  const tiles = Array.from({ length: TILE_COUNT }, (_, i) => REAL_COMPANIES[i % REAL_COMPANIES.length]);
  return (
    <div className="flex h-full w-full flex-col gap-6 px-16 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Every no, on the way to one yes</h1>
      <div className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-2">
        {tiles.map((company, i) => (
          <div
            key={`${company}-${i}`}
            className={cn(
              "flex aspect-square items-center justify-center rounded-md text-center text-[9px] leading-tight",
              i === OFFER_INDEX
                ? "bg-emerald-500 font-semibold text-black"
                : "bg-white/5 text-muted-foreground",
            )}
          >
            {i === OFFER_INDEX ? "OFFER" : company.slice(0, 3)}
          </div>
        ))}
      </div>
    </div>
  );
}
