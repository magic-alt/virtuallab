import type { editor } from "monaco-editor";

const visualWrapOptions = {
  wordWrap: "on" as const,
  wrappingIndent: "same" as const,
};

export function enforceDiffPaneWrapping(diffEditor: editor.IStandaloneDiffEditor) {
  // Monaco's diff-level diffWordWrap can leave the original/left editor with
  // stale wrapping state after side-by-side layout changes. Explicitly apply
  // visual wrapping to both inner editors. This only affects presentation;
  // neither model nor the working-tree/index content is modified.
  diffEditor.updateOptions({
    diffWordWrap: "on",
    ...visualWrapOptions,
  });

  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();

  originalEditor.updateOptions(visualWrapOptions);
  modifiedEditor.updateOptions(visualWrapOptions);

  originalEditor.layout();
  modifiedEditor.layout();
  diffEditor.layout();
}
