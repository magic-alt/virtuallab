import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type BadgeTone = "neutral" | "blue" | "green" | "amber" | "red";

const tones: Record<BadgeTone, string> = {
  neutral: "border-white/10 bg-white/[0.045] text-slate-300",
  blue: "border-blue-400/20 bg-blue-400/10 text-blue-200",
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
        "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium leading-none",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
