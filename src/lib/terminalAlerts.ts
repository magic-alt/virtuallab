/**
 * Detect OSC 9 desktop notifications and ordinary BELs in a PTY byte stream.
 * A terminal notification is an explicit signal, NOT proof that a shell exited.
 * Do not scrape rendered output or infer completion from idle output.
 *
 * OSC 9;4 is a progress-indicator protocol, not a user notification.
 * The parser is incremental because ConPTY/PTY can split sequences anywhere.
 */
export type TerminalSignal = { kind: "osc9"; message: string } | { kind: "bell" };

type ParseState = "text" | "escape" | "osc" | "osc-escape" | "discard" | "discard-escape";
const MAX_OSC_BYTES = 2048;

export class TerminalAlertParser {
  private state: ParseState = "text";
  private osc: number[] = [];

  feed(bytes: readonly number[]): TerminalSignal[] {
    const alerts: TerminalSignal[] = [];
    for (const byte of bytes) {
      switch (this.state) {
        case "text":
          if (byte === 27) this.state = "escape";
          else if (byte === 7) alerts.push({ kind: "bell" });
          break;
        case "escape":
          if (byte === 93) {
            this.osc = [];
            this.state = "osc";
          } else {
            this.state = byte === 27 ? "escape" : "text";
          }
          break;
        case "osc":
          if (byte === 7) {
            this.completeOsc(alerts);
            this.state = "text";
          } else if (byte === 27) {
            this.state = "osc-escape";
          } else {
            this.append(byte);
          }
          break;
        case "osc-escape":
          if (byte === 92) {
            this.completeOsc(alerts);
            this.state = "text";
          } else {
            if (this.osc.length + 2 > MAX_OSC_BYTES) {
              this.osc = [];
              this.state = "discard";
            } else {
              this.osc.push(27, byte);
              this.state = "osc";
            }
          }
          break;
        case "discard":
          if (byte === 7) this.state = "text";
          else if (byte === 27) this.state = "discard-escape";
          break;
        case "discard-escape":
          this.state = byte === 92 ? "text" : byte === 27 ? "discard-escape" : "discard";
          break;
      }
    }
    return alerts;
  }

  private append(byte: number) {
    if (this.osc.length >= MAX_OSC_BYTES) {
      this.osc = [];
      this.state = "discard";
    } else {
      this.osc.push(byte);
    }
  }

  private completeOsc(alerts: TerminalSignal[]) {
    // 9;<message> is a notification; 9;4;<state> is only progress.
    if (this.osc[0] !== 57 || this.osc[1] !== 59) return;
    const message = new TextDecoder().decode(new Uint8Array(this.osc.slice(2)))
      .replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (message && !/^4(?:;|$)/.test(message)) {
      alerts.push({ kind: "osc9", message: message.slice(0, 250) });
    }
    this.osc = [];
  }
}

/** Codex OSC 9 uses a plain preview for completion, but labels approval prompts. */
export function classifyOsc9(message: string): "attention" | "complete" {
  return /^(approval requested|codex wants to edit|plan mode prompt|user input|permission requested|elicitation requested)/i
    .test(message) ? "attention" : "complete";
}

/** Explicitly opt in to Codex TUI OSC 9 for a single terminal, not user-wide config. */
export const MONITORED_CODEX_COMMAND =
  "codex -c tui.notifications=true -c tui.notification_method=osc9 -c tui.notification_condition=always\r";
