import { beforeEach, describe, expect, it } from "vitest";
import { editorLabel, readPreferredEditor, savePreferredEditor } from "./externalEditor";

describe("external editor preference", () => {
  beforeEach(() => window.localStorage.clear());

  it("automatically discovers an installed editor until the user picks a default", () => {
    expect(readPreferredEditor()).toBe("auto");
    expect(editorLabel(readPreferredEditor())).toBe("default IDE");
    savePreferredEditor("zed");
    expect(readPreferredEditor()).toBe("zed");
    expect(editorLabel(readPreferredEditor())).toBe("Zed");
    savePreferredEditor("vscode");
    expect(readPreferredEditor()).toBe("vscode");
    expect(editorLabel(readPreferredEditor())).toBe("VS Code");
  });

  it("ignores unknown or corrupted persisted executable identifiers", () => {
    window.localStorage.setItem("virtuallab-external-editor", "cmd.exe /c something");
    expect(readPreferredEditor()).toBe("auto");
  });
});
