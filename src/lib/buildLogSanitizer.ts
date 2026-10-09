/**
 * Incremental display-only sanitizer for compiler stdout/stderr.
 *
 * Build tools produce ANSI terminal commands even when stdout is a pipe.
 * Rendering those commands inside a <pre> exposes boxes, "[32m" fragments,
 * and raw hyperlink controls. Keep stream state across arbitrary read chunks.
 * The interactive PTY terminal continues to use xterm and is unaffected.
 */
type Mode = "text" | "escape" | "csi" | "controlString" | "controlStringEscape";

export class BuildLogSanitizer {
  private mode: Mode = "text";
  private pendingCr = false;

  write(chunk: string): string {
    let result = "";
    for (const char of chunk) {
      if (this.pendingCr) {
        this.pendingCr = false;
        result += "\n";
        if (char === "\n") continue; // Treat CRLF (even split across reads) as one LF.
      }

      switch (this.mode) {
        case "text": {
          if (char === "\x1b") {
            this.mode = "escape";
          } else if (char === "\x9b") {
            this.mode = "csi";
          } else if (char === "\x9d") {
            this.mode = "controlString";
          } else if (char === "\r") {
            this.pendingCr = true;
          } else {
            const code = char.codePointAt(0) ?? 0;
            if (char === "\n" || char === "\t" ||
              (code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f))) {
              result += char;
            }
          }
          break;
        }
        case "escape":
          if (char === "[") this.mode = "csi";
          else if ("]PX^_".includes(char)) this.mode = "controlString";
          else this.mode = "text";
          break;
        case "csi": {
          const code = char.charCodeAt(0);
          if (code >= 0x40 && code <= 0x7e) this.mode = "text";
          else if (char === "\x1b") this.mode = "escape";
          break;
        }
        case "controlString":
          if (char === "\x07") this.mode = "text";
          else if (char === "\x1b") this.mode = "controlStringEscape";
          break;
        case "controlStringEscape":
          this.mode = char === "\\" || char === "\x07" ? "text" : "controlString";
          break;
      }
    }
    return result;
  }

  finish(): string {
    const last = this.pendingCr ? "\n" : "";
    this.pendingCr = false;
    this.mode = "text";
    return last;
  }
}
