import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function compactPath(path: string, max = 48) {
  if (path.length <= max) return path;
  const keep = Math.max(12, Math.floor((max - 3) / 2));
  return `${path.slice(0, keep)}...${path.slice(-keep)}`;
}

export function formatCommitTime(timestamp: number) {
  if (!timestamp) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}
