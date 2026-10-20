import { useSyncExternalStore } from "react";

export const DEFAULT_TERMINAL_FONT_SIZE = 15;
export const MIN_TERMINAL_FONT_SIZE = 12;
export const MAX_TERMINAL_FONT_SIZE = 22;
export const DEFAULT_TERMINAL_SCROLLBACK = 8000;
export const TERMINAL_SCROLLBACK_OPTIONS = [1000, 4000, 8000, 16000, 32000, 50000] as const;

const STORAGE_KEY = "virtuallab.terminal.fontSize";
const SCROLLBACK_KEY = 'virtuallab.terminal.scrollback';
const CURSOR_BLINK_KEY = 'virtuallab.terminal.cursorBlink';
const subscribers = new Set<() => void>();
const unsavedKeys = new Set<string>();
let fallbackFontSize = DEFAULT_TERMINAL_FONT_SIZE;
let fallbackScrollback = DEFAULT_TERMINAL_SCROLLBACK;
let fallbackCursorBlink = true;

export function clampTerminalFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(MAX_TERMINAL_FONT_SIZE, Math.round(value)));
}

export function readTerminalFontSize(): number {
  if (unsavedKeys.has(STORAGE_KEY)) return fallbackFontSize;
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
    if (event.key === STORAGE_KEY || event.key === SCROLLBACK_KEY || event.key === CURSOR_BLINK_KEY || event.key === null) {
      if (event.key === null) unsavedKeys.clear(); else unsavedKeys.delete(event.key);
      listener();
    }
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
    unsavedKeys.delete(STORAGE_KEY);
  } catch {
    // Quota failures may leave storage readable with an older preference.
    unsavedKeys.add(STORAGE_KEY);
  }
  for (const subscriber of subscribers) subscriber();
}

/** One preference shared by every mounted workspace, including hidden PTYs. */
export function useTerminalFontSize(): number {
  return useSyncExternalStore(subscribe, readTerminalFontSize, () => DEFAULT_TERMINAL_FONT_SIZE);
}

/** Only the bounded choices shown in Settings are accepted from persisted data. */
export function readTerminalScrollback(): number {
  if (unsavedKeys.has(SCROLLBACK_KEY)) return fallbackScrollback;
  try {
    const value = Number(window.localStorage.getItem(SCROLLBACK_KEY));
    return TERMINAL_SCROLLBACK_OPTIONS.some(option => option === value) ? value : DEFAULT_TERMINAL_SCROLLBACK;
  } catch { return fallbackScrollback; }
}

export function setTerminalScrollback(value: number): void {
  const next = Number.isFinite(value)
    ? TERMINAL_SCROLLBACK_OPTIONS.reduce((best, option) => Math.abs(option - value) < Math.abs(best - value) ? option : best)
    : DEFAULT_TERMINAL_SCROLLBACK;
  fallbackScrollback = next;
  try { window.localStorage.setItem(SCROLLBACK_KEY, String(next)); unsavedKeys.delete(SCROLLBACK_KEY); }
  catch { unsavedKeys.add(SCROLLBACK_KEY); }
  for (const listener of subscribers) listener();
}

export function useTerminalScrollback(): number {
  return useSyncExternalStore(subscribe, readTerminalScrollback, () => DEFAULT_TERMINAL_SCROLLBACK);
}

export function readTerminalCursorBlink(): boolean {
  if (unsavedKeys.has(CURSOR_BLINK_KEY)) return fallbackCursorBlink;
  try { return window.localStorage.getItem(CURSOR_BLINK_KEY) !== 'false'; }
  catch { return fallbackCursorBlink; }
}

export function setTerminalCursorBlink(value: boolean): void {
  fallbackCursorBlink = value;
  try { window.localStorage.setItem(CURSOR_BLINK_KEY, String(value)); unsavedKeys.delete(CURSOR_BLINK_KEY); }
  catch { unsavedKeys.add(CURSOR_BLINK_KEY); }
  for (const listener of subscribers) listener();
}

export function useTerminalCursorBlink(): boolean {
  return useSyncExternalStore(subscribe, readTerminalCursorBlink, () => true);
}
