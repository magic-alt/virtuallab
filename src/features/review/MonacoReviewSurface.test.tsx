import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const diffEditor = vi.hoisted(() => vi.fn());

vi.mock("@monaco-editor/react", () => ({
  DiffEditor: (props: unknown) => {
    diffEditor(props);
    return <div data-testid="mock-diff-editor" />;
  },
  loader: {
    config: vi.fn(),
  },
}));

vi.mock("./monacoEnvironment", () => ({}));

import { MonacoReviewSurface } from "./MonacoReviewSurface";

describe("MonacoReviewSurface", () => {
  it("uses visual word wrapping while remaining read-only", () => {
    render(
      <MonacoReviewSurface
        original={"very long original line"}
        modified={"very long modified line"}
        path="src/example.ts"
        layout="side-by-side"
      />,
    );

    expect(screen.getByTestId("mock-diff-editor")).toBeInTheDocument();
    const props = diffEditor.mock.calls.at(-1)?.[0] as {
      options: Record<string, unknown>;
    };

    expect(props.options).toEqual(
      expect.objectContaining({
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        renderSideBySide: true,
        wordWrap: "on",
        diffWordWrap: "on",
        wrappingIndent: "same",
      }),
    );
  });
});
