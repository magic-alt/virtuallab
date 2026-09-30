import { DiffEditor } from "@monaco-editor/react";
import "./monacoEnvironment";
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

  return (
    <div className="h-[620px] min-h-[620px]" data-testid="monaco-diff-surface">
      <DiffEditor
        height="100%"
        language={language}
        original={original}
        modified={modified}
        theme="vs-dark"
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
          wordWrap: "off",
          diffWordWrap: "off",
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
