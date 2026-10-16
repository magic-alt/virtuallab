import { useSyncExternalStore } from "react";

export const DEFAULT_TERMINAL_FONT_SIZE = 15;
export const MIN_TERMINAL_FONT_SIZE = 12;
export const MAX_TERMINAL_FONT_SIZE = 22;

const STORAGE_KEY = "virtuallab.terminal.fontSize";
const subscribers = new Set<() => void>();
let fallbackFontSize = DEFAULT_TERMINAL_FONT_SIZE;

export function clampTerminalFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(MAX_TERMINAL_FONT_SIZE, Math.round(value)));
}

export function readTerminalFontSize(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_TERMINAL_FONT_SIZE;
    const value = Number(raw);
    return Number.isInteger(value) ? clampTerminalFontSize(value) : DEFAULT_TERMINAL_FONT_SIZE;
  } catch {
    // Private browsing and locked-down WebViews may disallow localStorage.
    return fallbackFontSize;
  }
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    subscribers.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setTerminalFontSize(value: number): void {
  const next = clampTerminalFontSize(value);
  fallbackFontSize = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // Keep the current WebView responsive even if persistence is unavailable.
  }
  for (const subscriber of subscribers) subscriber();
}

/** One preference shared by every mounted workspace, including hidden PTYs. */
export function useTerminalFontSize(): number {
  return useSyncExternalStore(subscribe, readTerminalFontSize, () => DEFAULT_TERMINAL_FONT_SIZE);
}
