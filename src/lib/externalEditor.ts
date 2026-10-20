import { useSyncExternalStore } from 'react';

/** External IDEs supported by the native, shell-free workspace launcher. */
export type ExternalEditor = "auto" | "zed" | "vscode" | "cursor";

export const EXTERNAL_EDITORS: ReadonlyArray<{ id: ExternalEditor; label: string }> = [
  { id: "auto", label: "Auto-detect" },
  { id: "zed", label: "Zed" },
  { id: "vscode", label: "VS Code" },
  { id: "cursor", label: "Cursor" },
];

export function editorLabel(editor: ExternalEditor): string {
  if (editor === "auto") return "default IDE";
  return EXTERNAL_EDITORS.find((item) => item.id === editor)?.label ?? "default IDE";
}

const STORAGE_KEY = "virtuallab-external-editor";
const subscribers = new Set<() => void>();
let fallbackEditor: ExternalEditor = 'auto';
let unsavedEditor = false;

function validatedEditor(value: unknown): ExternalEditor {
  return EXTERNAL_EDITORS.some(item => item.id === value) ? value as ExternalEditor : 'auto';
}

export function readPreferredEditor(): ExternalEditor {
  if (unsavedEditor) return fallbackEditor;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return validatedEditor(saved);
  } catch { return fallbackEditor; }
}

export function savePreferredEditor(editor: ExternalEditor): void {
  fallbackEditor = validatedEditor(editor);
  try {
    window.localStorage.setItem(STORAGE_KEY, fallbackEditor);
    unsavedEditor = false;
  } catch { unsavedEditor = true; }
  for (const listener of subscribers) listener();
}
function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  const storage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) { unsavedEditor = false; listener(); }
  };
  window.addEventListener('storage', storage);
  return () => { subscribers.delete(listener); window.removeEventListener('storage', storage); };
}

/** Shared by global Settings and every mounted workspace launcher. */
export function usePreferredEditor(): ExternalEditor {
  return useSyncExternalStore(subscribe, readPreferredEditor, () => 'auto');
}
