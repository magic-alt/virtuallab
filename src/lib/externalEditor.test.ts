import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { editorLabel, readPreferredEditor, savePreferredEditor, usePreferredEditor } from "./externalEditor";

describe("external editor preference", () => {
  beforeEach(() => window.localStorage.clear());

  it('updates mounted consumers for local and storage-event changes', () => {
    function Consumer() {return createElement('output', null, usePreferredEditor());}
    render(createElement(Consumer));
    expect(screen.getByRole('status')).toHaveTextContent('auto');
    act(() => savePreferredEditor('zed'));
    expect(screen.getByRole('status')).toHaveTextContent('zed');
    act(() => {
      window.localStorage.setItem('virtuallab-external-editor', 'cursor');
      window.dispatchEvent(new StorageEvent('storage', {key:'virtuallab-external-editor'}));
    });
    expect(screen.getByRole('status')).toHaveTextContent('cursor');
  });

  it('keeps a validated in-memory preference when storage is unavailable', () => {
    const write = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {throw new Error('unavailable');});
    savePreferredEditor('vscode');
    expect(readPreferredEditor()).toBe('vscode');
    savePreferredEditor('unsafe' as never);
    expect(readPreferredEditor()).toBe('auto');
    write.mockRestore();
    savePreferredEditor('auto');
  });

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
