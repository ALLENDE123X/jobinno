"use client";

/**
 * The pipeline picture: what goes in, what happens in the middle, what comes
 * out (JOB-016).
 *
 * Deliberately three columns and nothing more. The real pipeline has a lot more
 * steps than this, and drawing all of them would make the picture accurate and
 * unreadable at the same time. The one thing a visitor needs to take from it is
 * that they hand over their material once and submissions come out the far side
 * without them.
 *
 * `AnimatedBeam` measures the two endpoints against a container, so every node
 * needs its own ref and the container needs `position: relative`.
 */

import { useRef, type RefObject } from "react";
import { ClipboardList, FileText, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { AnimatedBeam } from "@/components/ui/animated-beam";

function Node({
  nodeRef,
  label,
  monogram,
  icon,
  large = false,
}: {
  nodeRef: RefObject<HTMLDivElement | null>;
  label: string;
  monogram?: string;
  icon?: React.ReactNode;
  large?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        ref={nodeRef}
        className={cn(
          "z-10 flex items-center justify-center rounded-full border bg-background shadow-sm",
          large ? "size-14 sm:size-16" : "size-10 sm:size-12"
        )}
      >
        {icon ?? (
          <span className="text-sm font-semibold sm:text-base">{monogram}</span>
        )}
      </div>
      <span className="max-w-[5.5rem] text-center text-[10px] leading-tight text-muted-foreground sm:max-w-none sm:text-xs">
        {label}
      </span>
    </div>
  );
}

export function PipelineDiagram() {
  const container = useRef<HTMLDivElement>(null);
  const resume = useRef<HTMLDivElement>(null);
  const intake = useRef<HTMLDivElement>(null);
  const agent = useRef<HTMLDivElement>(null);
  const greenhouse = useRef<HTMLDivElement>(null);
  const lever = useRef<HTMLDivElement>(null);
  const ashby = useRef<HTMLDivElement>(null);
  const workable = useRef<HTMLDivElement>(null);

  const outputs = [greenhouse, lever, ashby, workable];

  return (
    <div
      ref={container}
      className="relative mx-auto flex w-full max-w-3xl items-stretch justify-between gap-2 overflow-hidden rounded-2xl border bg-card/40 p-4 sm:gap-6 sm:p-8"
    >
      <div className="flex flex-col justify-center gap-10 sm:gap-14">
        <Node
          nodeRef={resume}
          label="Resume"
          icon={<FileText className="size-4 sm:size-5" />}
        />
        <Node
          nodeRef={intake}
          label="Intake answers"
          icon={<ClipboardList className="size-4 sm:size-5" />}
        />
      </div>

      <div className="flex flex-col items-center justify-center">
        <Node
          nodeRef={agent}
          label="Matched against live postings"
          icon={<Sparkles className="size-5 sm:size-6" />}
          large
        />
      </div>

      <div className="flex flex-col justify-center gap-4 sm:gap-6">
        <Node nodeRef={greenhouse} label="Greenhouse" monogram="G" />
        <Node nodeRef={lever} label="Lever" monogram="L" />
        <Node nodeRef={ashby} label="Ashby" monogram="A" />
        <Node nodeRef={workable} label="Workable" monogram="W" />
      </div>

      {/*
        Every beam is drawn straight. `AnimatedBeam`'s curvature bows the path
        through a control point above or below the midpoint, and with four
        beams leaving one node that produced a knot where the curves crossed
        each other rather than a fan. Straight spokes read correctly at every
        width, including 390 pixels.
      */}
      <AnimatedBeam
        containerRef={container}
        fromRef={resume}
        toRef={agent}
        duration={3}
      />
      <AnimatedBeam
        containerRef={container}
        fromRef={intake}
        toRef={agent}
        duration={3}
        delay={0.6}
      />
      {outputs.map((output, index) => (
        <AnimatedBeam
          key={index}
          containerRef={container}
          fromRef={agent}
          toRef={output}
          duration={3}
          delay={1.2 + index * 0.25}
        />
      ))}
    </div>
  );
}
