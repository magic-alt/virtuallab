import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MonacoReviewSurface } from "./MonacoReviewSurface";

// Test the actual options passed to the Monaco React wrapper. Mocking the
// browser editor itself keeps this regression independent of WebView workers.
const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock("./monacoEnvironment", () => ({}));
vi.mock("@monaco-editor/react", async () => {
  const { useEffect } = await import("react");
  return {
    DiffEditor: ({
      original,
      modified,
      options,
    }: {
      original: string;
      modified: string;
      options: {
        renderSideBySide: boolean;
        useInlineViewWhenSpaceIsLimited: boolean;
        wordWrap: string;
        diffWordWrap: string;
        wrappingIndent: string;
      };
    }) => {
      useEffect(() => {
        lifecycle.mounts += 1;
        return () => { lifecycle.unmounts += 1; };
      }, []);
      return (
        <div
          data-testid="mock-diff-editor"
          data-original={original}
          data-modified={modified}
          data-split={String(options.renderSideBySide)}
          data-inline-fallback={String(options.useInlineViewWhenSpaceIsLimited)}
          data-word-wrap={options.wordWrap}
          data-diff-word-wrap={options.diffWordWrap}
          data-wrapping-indent={options.wrappingIndent}
        />
      );
    },
  };
});

describe("MonacoReviewSurface split wrapping", () => {
  beforeEach(() => {
    lifecycle.mounts = 0;
    lifecycle.unmounts = 0;
  });

  it("wraps both panes, disables implicit inline fallback and preserves the source text", () => {
    const original = "original very long README description ".repeat(12);
    const modified = "modified very long README description ".repeat(12);
    render(
      <MonacoReviewSurface
        original={original}
        modified={modified}
        path="README.md"
        layout="side-by-side"
      />,
    );
    const diff = screen.getByTestId("mock-diff-editor");
    expect(diff).toHaveAttribute("data-split", "true");
    expect(diff).toHaveAttribute("data-inline-fallback", "false");
    expect(diff).toHaveAttribute("data-word-wrap", "on");
    expect(diff).toHaveAttribute("data-diff-word-wrap", "on");
    expect(diff).toHaveAttribute("data-wrapping-indent", "same");
    expect(diff).toHaveAttribute("data-original", original);
    expect(diff).toHaveAttribute("data-modified", modified);
  });

  it("creates fresh Monaco editors when toggling split/unified/split", () => {
    const props = { original: "old line", modified: "new line", path: "README.md" };
    const view = render(<MonacoReviewSurface {...props} layout="side-by-side" />);
    expect(lifecycle.mounts).toBe(1);
    view.rerender(<MonacoReviewSurface {...props} layout="unified" />);
    expect(screen.getByTestId("mock-diff-editor")).toHaveAttribute("data-split", "false");
    expect(lifecycle).toEqual({ mounts: 2, unmounts: 1 });
    view.rerender(<MonacoReviewSurface {...props} layout="side-by-side" />);
    expect(screen.getByTestId("mock-diff-editor")).toHaveAttribute("data-split", "true");
    expect(lifecycle).toEqual({ mounts: 3, unmounts: 2 });
    expect(screen.getByTestId("mock-diff-editor")).toHaveAttribute("data-word-wrap", "on");
    expect(screen.getByTestId("mock-diff-editor")).toHaveAttribute("data-inline-fallback", "false");
    view.unmount();
    expect(lifecycle.unmounts).toBe(3);
  });
});
