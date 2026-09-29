import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type ButtonVariant = "primary" | "outline" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}

const variants: Record<ButtonVariant, string> = {
  primary:
    "border border-orange-400/30 bg-orange-500/90 text-white shadow-[0_10px_30px_rgba(249,115,22,0.16)] hover:bg-orange-400",
  outline:
    "border border-white/10 bg-white/[0.035] text-slate-200 hover:border-white/20 hover:bg-white/[0.07]",
  ghost: "border border-transparent text-slate-400 hover:bg-white/[0.05] hover:text-slate-100",
};

export function Button({
  className,
  variant = "primary",
  size = "md",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:pointer-events-none disabled:opacity-45",
        size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
