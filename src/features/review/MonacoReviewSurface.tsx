import { DiffEditor } from "@monaco-editor/react";
import { useCallback, useEffect, useRef } from "react";
import "./monacoEnvironment";
import type { editor } from "monaco-editor";
import { enforceDiffPaneWrapping } from "./diffPaneWrapping";
import { reviewLanguage } from "./reviewLanguage";

export function MonacoReviewSurface({
  original,
  modified,
  path,
  layout,
}: {
  original: string;
  modified: string;
  path: string;
  layout: "unified" | "side-by-side";
}) {
  const language = reviewLanguage(path);
  const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null);

  const applyWrapping = useCallback((instance: editor.IStandaloneDiffEditor) => {
    enforceDiffPaneWrapping(instance);
  }, []);

  const handleMount = useCallback(
    (instance: editor.IStandaloneDiffEditor) => {
      diffEditorRef.current = instance;
      applyWrapping(instance);
    },
    [applyWrapping],
  );

  useEffect(() => {
    const instance = diffEditorRef.current;
    if (!instance) return;

    // @monaco-editor/react updates the diff options when the layout toggle
    // changes. Re-apply wrapping on the next frame so both inner editors see
    // the final side-by-side/inline geometry.
    const frame = window.requestAnimationFrame(() => {
      applyWrapping(instance);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [applyWrapping, layout]);

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
          // Visual wrapping only: long lines adapt to the current review pane
          // width without changing either Git side or the working-tree file.
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
