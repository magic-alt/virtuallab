import { DiffEditor } from "@monaco-editor/react";
import { useCallback, useEffect, useRef } from "react";
import "./monacoEnvironment";
import type { editor, IDisposable } from "monaco-editor";
import { enforceDiffPaneWrapping } from "./diffPaneWrapping";
import { reviewLanguage } from "./reviewLanguage";
import type { ReviewLineSelection } from "@/types/workbench";

export function MonacoReviewSurface({
  original,
  modified,
  path,
  layout,
  onReviewLineSelect,
}: {
  original: string;
  modified: string;
  path: string;
  layout: "unified" | "side-by-side";
  onReviewLineSelect?: (selection: ReviewLineSelection) => void;
}) {
  const language = reviewLanguage(path);
  const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const listenersRef = useRef<IDisposable[]>([]);
  const selectionCallbackRef = useRef(onReviewLineSelect);
  selectionCallbackRef.current = onReviewLineSelect;

  const applyWrapping = useCallback((instance: editor.IStandaloneDiffEditor) => {
    enforceDiffPaneWrapping(instance);
  }, []);

  const bindReviewSelection = useCallback((instance: editor.IStandaloneDiffEditor) => {
    listenersRef.current.forEach((listener) => listener.dispose());
    listenersRef.current = [
      instance.getOriginalEditor().onDidChangeCursorSelection(({ selection }) => {
        selectionCallbackRef.current?.({
          line: selection.positionLineNumber,
          side: "LEFT",
        });
      }),
      instance.getModifiedEditor().onDidChangeCursorSelection(({ selection }) => {
        selectionCallbackRef.current?.({
          line: selection.positionLineNumber,
          side: "RIGHT",
        });
      }),
    ];
  }, []);

  const handleMount = useCallback(
    (instance: editor.IStandaloneDiffEditor) => {
      diffEditorRef.current = instance;
      applyWrapping(instance);
      bindReviewSelection(instance);
    },
    [applyWrapping, bindReviewSelection],
  );

  useEffect(() => {
    const instance = diffEditorRef.current;
    if (!instance) return;

    const frame = window.requestAnimationFrame(() => {
      applyWrapping(instance);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [applyWrapping, layout]);

  useEffect(
    () => () => {
      listenersRef.current.forEach((listener) => listener.dispose());
      listenersRef.current = [];
    },
    [],
  );

  return (
    <div className="h-full min-h-0 w-full" data-testid="monaco-diff-surface">
      <DiffEditor
        height="100%"
        width="100%"
        language={language}
        original={original}
        modified={modified}
        theme="vs-dark"
        onMount={handleMount}
        options={{
          automaticLayout: true,
          readOnly: true,
          originalEditable: false,
          renderSideBySide: layout === "side-by-side",
          useInlineViewWhenSpaceIsLimited: true,
          enableSplitViewResizing: true,
          renderOverviewRuler: false,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: "on",
          diffWordWrap: "on",
          wrappingIndent: "same",
          ignoreTrimWhitespace: false,
          fontFamily:
            '"Cascadia Code", "JetBrains Mono", "Cascadia Mono", "SFMono-Regular", Consolas, monospace',
          fontSize: 12,
          lineHeight: 18,
          glyphMargin: false,
          folding: false,
          renderIndicators: true,
          stickyScroll: { enabled: false },
          overviewRulerBorder: false,
          padding: { top: 10, bottom: 10 },
        }}
      />
    </div>
  );
}
