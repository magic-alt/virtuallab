import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type ButtonVariant = "primary" | "outline" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}

const variants: Record<ButtonVariant, string> = {
  primary:
    "border border-[#ff9b28] bg-[#e86400] text-[#fff3de] shadow-[2px_2px_0_#5a1c00] hover:bg-[#ff7900] active:translate-x-[1px] active:translate-y-[1px] active:shadow-none",
  outline:
    "border border-[#db6500] bg-[#6d2400] text-[#ffe6c4] shadow-[2px_2px_0_#4b1700] hover:border-[#ff9b28] hover:bg-[#7f2c00] active:translate-x-[1px] active:translate-y-[1px] active:shadow-none",
  ghost: "border border-transparent text-[#efb06f] hover:border-[#d86600] hover:bg-[#6d2400] hover:text-[#fff0d2]",
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
        "inline-flex items-center justify-center gap-2 rounded-lg font-semibold uppercase tracking-[0.03em] transition disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
