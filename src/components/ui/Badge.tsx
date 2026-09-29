import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type BadgeTone = "neutral" | "blue" | "orange" | "green" | "amber" | "red";

const tones: Record<BadgeTone, string> = {
  neutral: "border-[#bd5600] bg-[#6b2300] text-[#f3bd83]",
  blue: "border-[#d06300] bg-[#762700] text-[#ffc072]",
  orange: "border-[#ff8b14] bg-[#803000] text-[#ffd09b]",
  green: "border-emerald-400/20 bg-emerald-400/10 text-emerald-200",
  amber: "border-amber-400/20 bg-amber-400/10 text-amber-200",
  red: "border-rose-400/20 bg-rose-400/10 text-rose-200",
};

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.04em] leading-none",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
