import { describe, expect, it } from "vitest";
import capabilities from "../../src-tauri/capabilities/default.json";
import config from "../../src-tauri/tauri.conf.json";

describe("native desktop event ACL", () => {
  it("binds the generated desktop capability to the main Tauri window", () => {
    // A capability file is not enough if app.security.capabilities overrides
    // discovery. This checks the permissions the packaged window is configured
    // to load, not a Vitest mock of @tauri-apps/api/event.
    expect(config.app.windows[0].label).toBe("main");
    expect(config.app.security.capabilities).toEqual([capabilities.identifier]);
    expect(capabilities.windows).toContain("main");
  });

  it("permits both terminal/event subscriptions and their cleanup", () => {
    // core:default normally includes these, but explicitly requiring them
    // catches packaging/config regressions that strand Start Terminal disabled.
    expect(capabilities.permissions).toContain("core:event:allow-listen");
    expect(capabilities.permissions).toContain("core:event:allow-unlisten");
    expect(capabilities.permissions).toContain("core:default");
    expect(capabilities.permissions).not.toContain("core:event:deny-listen");
    expect(capabilities.permissions).not.toContain("core:event:deny-unlisten");
  });

  it("keeps dialog permissions for existing native confirmation flows", () => {
    expect(capabilities.permissions).toContain("dialog:allow-open");
    expect(capabilities.permissions).toContain("dialog:allow-message");
  });
});
