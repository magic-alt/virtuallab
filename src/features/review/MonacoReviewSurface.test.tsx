import { describe, expect, it, vi } from "vitest";
import type { editor } from "monaco-editor";
import { enforceDiffPaneWrapping } from "./diffPaneWrapping";

describe("enforceDiffPaneWrapping", () => {
  it("forces visual wrapping on both original and modified diff panes", () => {
    const original = {
      updateOptions: vi.fn(),
      layout: vi.fn(),
    };
    const modified = {
      updateOptions: vi.fn(),
      layout: vi.fn(),
    };
    const diff = {
      updateOptions: vi.fn(),
      getOriginalEditor: () => original,
      getModifiedEditor: () => modified,
      layout: vi.fn(),
    } as unknown as editor.IStandaloneDiffEditor;

    enforceDiffPaneWrapping(diff);

    expect(diff.updateOptions).toHaveBeenCalledWith({
      diffWordWrap: "on",
      wordWrap: "on",
      wrappingIndent: "same",
    });
    expect(original.updateOptions).toHaveBeenCalledWith({
      wordWrap: "on",
      wrappingIndent: "same",
    });
    expect(modified.updateOptions).toHaveBeenCalledWith({
      wordWrap: "on",
      wrappingIndent: "same",
    });
    expect(original.layout).toHaveBeenCalledTimes(1);
    expect(modified.layout).toHaveBeenCalledTimes(1);
    expect(diff.layout).toHaveBeenCalledTimes(1);
  });
});
