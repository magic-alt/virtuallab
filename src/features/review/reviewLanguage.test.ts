import { describe, expect, it } from "vitest";
import { reviewLanguage } from "./reviewLanguage";

describe("reviewLanguage", () => {
  it("maps common engineering source files", () => {
    expect(reviewLanguage("src/app.tsx")).toBe("typescript");
    expect(reviewLanguage("src-tauri/src/git.rs")).toBe("rust");
    expect(reviewLanguage("config/settings.json")).toBe("json");
    expect(reviewLanguage("docs/README.md")).toBe("markdown");
    expect(reviewLanguage("scripts/build.ps1")).toBe("powershell");
  });

  it("falls back safely for unknown files", () => {
    expect(reviewLanguage("LICENSE")).toBe("plaintext");
    expect(reviewLanguage("data/custom.foo")).toBe("plaintext");
  });
});
