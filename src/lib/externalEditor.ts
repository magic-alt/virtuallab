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

export function readPreferredEditor(): ExternalEditor {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (EXTERNAL_EDITORS.some((item) => item.id === saved)) return saved as ExternalEditor;
  } catch { /* Private browsing / unavailable localStorage: keep safe default. */ }
  return "auto";
}

export function savePreferredEditor(editor: ExternalEditor): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, editor);
  } catch { /* Launcher remains usable without persistence. */ }
}
