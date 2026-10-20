import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  Minus,
  Plus,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  terminalResize,
  terminalSpawn,
  terminalStop,
  terminalWrite,
} from "@/lib/backend";
import { cn } from "@/lib/utils";
import { workspaceKey } from "@/lib/workspaceKey";
import { TerminalAlertParser, classifyOsc9, MONITORED_CODEX_COMMAND } from "@/lib/terminalAlerts";
import { publishTaskNotice, useTaskNotifications } from "@/stores/taskNotifications";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  setTerminalFontSize,
  useTerminalFontSize,
  useTerminalScrollback,
  useTerminalCursorBlink,
} from "./terminalAppearance";
import type { TerminalOutput, WorkbenchEvent } from "@/types/workbench";

interface Session {
  id: string;
  title: string;
  status: "starting" | "running" | "stopped" | "error";
  monitoredAgent?: "codex";
}

interface TerminalHandle {
  terminal: Terminal;
  fit: FitAddon;
}

export function TerminalWorkspace({
  cwd,
  enabled,
  visible = true,
  repositoryId = null,
}: {
  cwd: string;
  enabled: boolean;
  visible?: boolean;
  repositoryId?: string | null;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listenersReady, setListenersReady] = useState(false);
  const scope = workspaceKey(cwd);
  const fontSize = useTerminalFontSize();
  const scrollback = useTerminalScrollback();
  const cursorBlink = useTerminalCursorBlink();
  const handles = useRef(new Map<string, TerminalHandle>());
  const pending = useRef(new Map<string, number[][]>());
  const sessionsRef = useRef<Session[]>([]);
  const visibleRef = useRef(visible);
  const activeIdRef = useRef(activeId);
  const parsers = useRef(new Map<string, TerminalAlertParser>());
  const lastBellAt = useRef(new Map<string, number>());
  const lastOsc = useRef(new Map<string, { message: string; at: number }>());
  const alertSequence = useRef(0);
  const target = useTaskNotifications((state) => state.terminalTarget);
  const consumeTarget = useTaskNotifications((state) => state.consumeTerminalTarget);
  sessionsRef.current = sessions;
  visibleRef.current = visible;
  activeIdRef.current = activeId;

  useEffect(() => {
    if (!visible || !target || workspaceKey(target.workspaceRoot) !== scope) return;
    if (!sessionsRef.current.some((session) => session.id === target.id)) return;
    setActiveId(target.id);
    consumeTarget(target.sequence);
  }, [visible, scope, target, consumeTarget]);

  // Install both event subscriptions before enabling shell creation. Otherwise
  // a fast Windows ConPTY prompt can disappear before anyone is listening.
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let outputUnlisten: UnlistenFn | undefined;
    let eventUnlisten: UnlistenFn | undefined;

    const connect = async () => {
      try {
        const stopOutput = await listen<TerminalOutput>("terminal://output", ({ payload }) => {
          const session = sessionsRef.current.find((item) => item.id === payload.id);
          if (!session) return;
          const parser = parsers.current.get(payload.id);
          if (parser && session.status !== "stopped" && session.status !== "error") {
            // PTY bytes are kept intact for xterm; only explicit control signals are
            // inspected. A quiet/still-running CLI is never considered complete.
            for (const signal of parser.feed(payload.data)) {
              const focused = visibleRef.current && activeIdRef.current === payload.id && document.hasFocus();
              const now = Date.now();
              if (signal.kind === "bell") {
                // A BEL may be an approval request or any application's bell.
                // It is intentionally NEVER reported as a completed turn.
                if (focused || now - (lastBellAt.current.get(payload.id) ?? 0) < 30000) continue;
                lastBellAt.current.set(payload.id, now);
                publishTaskNotice({
                  id: "terminal:" + payload.id + ":bell:" + (++alertSequence.current),
                  source: "terminal", terminalId: payload.id, workspaceRoot: cwd, repositoryId,
                  title: "Terminal needs attention",
                  detail: session.title + " sent an alert. Open Terminal to review.",
                  severity: "attention",
                }, focused);
              } else {
                // Some CLIs replay their last notification on view changes.
                // Suppress immediate identical repeats, but allow new turns later.
                const previous = lastOsc.current.get(payload.id);
                if (previous?.message === signal.message && now - previous.at < 5000) continue;
                lastOsc.current.set(payload.id, { message: signal.message, at: now });
                const kind = session.monitoredAgent ? classifyOsc9(signal.message) : "attention";
                publishTaskNotice({
                  id: "terminal:" + payload.id + ":osc9:" + (++alertSequence.current),
                  source: "terminal", terminalId: payload.id, workspaceRoot: cwd, repositoryId,
                  title: session.monitoredAgent === "codex"
                    ? (kind === "complete" ? "Codex task completed" : "Codex needs attention")
                    : "Terminal notification",
                  detail: session.title + (kind === "complete" ? " finished a Codex turn. Open Terminal to review."
                    : " requested attention. Open Terminal to review."),
                  severity: kind === "complete" ? "complete" : "attention",
                }, focused);
              }
            }
          }
          const handle = handles.current.get(payload.id);
          if (handle) {
            handle.terminal.write(new Uint8Array(payload.data));
          } else {
            const chunks = pending.current.get(payload.id) ?? [];
            chunks.push(payload.data);
            if (chunks.length > 256) chunks.shift();
            pending.current.set(payload.id, chunks);
          }
        });
        if (disposed) { stopOutput(); return; }
        outputUnlisten = stopOutput;

        const stopEvents = await listen<WorkbenchEvent>("workbench://event", ({ payload }) => {
          if (!payload.eventType.startsWith("terminal.")) return;
          if (!sessionsRef.current.some((session) => session.id === payload.id)) return;
          if (payload.eventType === "terminal.started") {
            setSessions((items) =>
              items.map((item) =>
                item.id === payload.id && item.status === "starting"
                  ? { ...item, status: "running" } : item,
              ),
            );
          } else if (
            payload.eventType === "terminal.exited" ||
            payload.eventType === "terminal.stopped"
          ) {
            setSessions((items) =>
              items.map((item) =>
                item.id === payload.id ? { ...item, status: "stopped" } : item,
              ),
            );
          } else if (payload.eventType === "terminal.cleanup_failed") {
            setError(payload.data ?? "Failed to clean up terminal process.");
          }
        });
        if (disposed) { stopEvents(); return; }
        eventUnlisten = stopEvents;
        setListenersReady(true);
      } catch (cause) {
        outputUnlisten?.();
        outputUnlisten = undefined;
        if (!disposed) {
          setListenersReady(false);
          setError(`Cannot subscribe to terminal events: ${String(cause)}`);
        }
      }
    };
    setListenersReady(false);
    void connect();

    return () => {
      disposed = true;
      outputUnlisten?.();
      eventUnlisten?.();
      // WorkspaceTerminals keeps this instance mounted during navigation.
      // Cleanup runs when the workbench is torn down.
      for (const item of sessionsRef.current) {
        if (item.status === "running" || item.status === "starting") {
          void terminalStop(item.id).catch(() => undefined);
        }
      }
    };
  }, [enabled]);

  useEffect(() => {
    for (const item of sessionsRef.current) {
      if (item.status === "running" || item.status === "starting") {
        void Promise.resolve(terminalStop(item.id)).catch(() => undefined);
      }
    }
    handles.current.clear();
    pending.current.clear();
    parsers.current.clear();
    lastBellAt.current.clear();
    lastOsc.current.clear();
    setSessions([]);
    setActiveId(null);
    setError(null);
  }, [scope]);

  const start = async (monitoredAgent: "codex" | null = null) => {
    if (!enabled || !listenersReady || sessionsRef.current.length >= 8) return;

    const id =
      globalThis.crypto?.randomUUID?.() ??
      `terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const title = `Terminal ${sessions.length + 1}`;

    const next: Session[] = [...sessionsRef.current, {
      id, title, status: "starting", monitoredAgent: monitoredAgent ?? undefined,
    }];
    sessionsRef.current = next;
    setSessions(next);
    setActiveId(id);
    pending.current.set(id, []);
    parsers.current.set(id, new TerminalAlertParser());
    setError(null);

    try {
      await terminalSpawn(id, cwd, 120, 32);
      // Invoke success is an additional acknowledgement; a late reply must
      // never revive a session already stopped by a native exit event.
      setSessions((items) =>
        items.map((item) =>
          item.id === id && item.status === "starting"
            ? { ...item, status: "running" } : item,
        ),
      );
      if (monitoredAgent === "codex" &&
          sessionsRef.current.some((item) => item.id === id && item.status !== "stopped")) {
        await terminalWrite(id, new TextEncoder().encode(MONITORED_CODEX_COMMAND));
      }
    } catch (err) {
      if (!sessionsRef.current.some((item) => item.id === id)) return;
      setSessions((items) =>
        items.map((item) =>
          item.id === id && item.status === "starting"
            ? { ...item, status: "error" } : item,
        ),
      );
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const stop = async (id: string) => {
    try {
      await terminalStop(id);
      setSessions((items) => items.map((item) => item.id === id ? { ...item, status: "stopped" } : item));
    } catch (cause) { setError(String(cause)); }
  };

  const close = async (id: string) => {
    try {
      await terminalStop(id);
      const next = sessionsRef.current.filter((session) => session.id !== id);
      sessionsRef.current = next;
      pending.current.delete(id);
      parsers.current.delete(id);
      lastBellAt.current.delete(id);
      lastOsc.current.delete(id);
      setSessions(next);
      setActiveId((current) => current === id ? next.at(-1)?.id ?? null : current);
    } catch (cause) { setError(String(cause)); }
  };

  const handleAttach = useCallback((id: string, handle: TerminalHandle) => {
    handles.current.set(id, handle);
    for (const bytes of pending.current.get(id) ?? []) {
      handle.terminal.write(new Uint8Array(bytes));
    }
    pending.current.set(id, []);
  }, []);

  const handleDetach = useCallback((id: string) => {
    handles.current.delete(id);
  }, []);

  const reportInputError = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  return (
    <div className="vl-editor-surface vl-terminal-workspace mx-auto flex h-full min-h-[520px] max-w-[1320px] flex-col overflow-hidden rounded-2xl border border-white/[0.08] shadow-[4px_4px_0_rgba(58,16,0,0.55)]">
      <div className="flex h-11 shrink-0 items-center border-b border-orange-400/10 bg-[#120b06] px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={cn(
                "flex h-8 shrink-0 items-center gap-2 rounded-lg px-3 text-xs transition",
                activeId === session.id
                  ? "bg-orange-400/10 text-orange-100"
                  : "text-slate-500 hover:bg-white/[0.04] hover:text-slate-300",
              )}
              onClick={() => setActiveId(session.id)}
              type="button"
            >
              <TerminalSquare size={13} />
              {session.title}
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  session.status === "running"
                    ? "bg-emerald-400"
                    : session.status === "starting"
                      ? "bg-amber-400"
                      : session.status === "error"
                        ? "bg-rose-400"
                        : "bg-slate-700",
                )}
              />
            </button>
          ))}
        </div>

        <div role="group" aria-label="Terminal font size" className="ml-2 flex shrink-0 items-center gap-0.5 border-l border-orange-400/15 pl-2">
          <button
            type="button"
            aria-label="Decrease terminal font size"
            title="Decrease terminal font size"
            disabled={fontSize <= MIN_TERMINAL_FONT_SIZE}
            onClick={() => setTerminalFontSize(fontSize - 1)}
            className="flex size-7 items-center justify-center rounded text-orange-200 hover:bg-orange-400/10 disabled:opacity-35"
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            aria-label="Reset terminal font size"
            title="Reset terminal font size"
            disabled={fontSize === DEFAULT_TERMINAL_FONT_SIZE}
            onClick={() => setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE)}
            className="min-w-11 rounded px-1 py-1 text-xs tabular-nums text-orange-100 hover:bg-orange-400/10 disabled:opacity-70"
          >
            {fontSize}px
          </button>
          <button
            type="button"
            aria-label="Increase terminal font size"
            title="Increase terminal font size"
            disabled={fontSize >= MAX_TERMINAL_FONT_SIZE}
            onClick={() => setTerminalFontSize(fontSize + 1)}
            className="flex size-7 items-center justify-center rounded text-orange-200 hover:bg-orange-400/10 disabled:opacity-35"
          >
            <Plus size={14} />
          </button>
        </div>

        <Button disabled={!enabled || !listenersReady || sessions.length >= 8} onClick={() => void start()} size="sm" variant="ghost">
          <Plus size={14} />
          New terminal
        </Button>
        <Button disabled={!enabled || !listenersReady || sessions.length >= 8}
          onClick={() => void start("codex")} size="sm" variant="ghost"
          title="Launch Codex with OSC 9 turn completion and approval alerts, without changing global Codex settings">
          <TerminalSquare size={14} />
          Start Codex
        </Button>

        {activeId && <Button aria-label="Close terminal" onClick={() => void close(activeId)} size="sm" variant="ghost"><X size={12} /> Close</Button>}
        {activeId && (
          <Button
            onClick={() => void stop(activeId)}
            size="sm"
            variant="ghost"
          >
            <Square size={12} />
            Stop
          </Button>
        )}
      </div>

      <div className="relative min-h-0 flex-1 bg-[#090704]">
        {sessions.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
            <div className="flex size-11 items-center justify-center rounded-xl border border-orange-400/15 bg-orange-400/10 text-orange-300">
              <TerminalSquare size={19} />
            </div>
            <div className="mt-4 text-sm font-medium text-slate-200">
              Workspace terminal
            </div>
            <div className="mt-1 max-w-md text-xs leading-5 text-slate-600">
              {enabled
                ? listenersReady
                  ? "Start your system's interactive shell in VirtualLab (PowerShell/CMD on Windows, your configured shell on macOS/Linux). Supports resize, Ctrl+C and direct input."
                  : "Connecting native terminal events…"
                : "Native PTY execution is available in the Tauri desktop runtime. The web build remains a safe UI preview."}
            </div>
            {enabled && (
              <div className="mt-5 flex items-center gap-2">
                <Button disabled={!listenersReady} onClick={() => void start()}>
                  <TerminalSquare size={14} />
                  Start terminal
                </Button>
                <Button disabled={!listenersReady} onClick={() => void start("codex")} variant="ghost">
                  Start Codex with alerts
                </Button>
              </div>
            )}
          </div>
        ) : (
          sessions.map((session) => (
            <TerminalSurface
              key={session.id}
              id={session.id}
              active={session.id === activeId}
              visible={visible}
              fontSize={fontSize}
              scrollback={scrollback}
              cursorBlink={cursorBlink}
              // ConPTY can request cursor position (CSI 6n) before the spawn
              // acknowledgement. xterm must be able to answer CSI 1;1R while
              // the session is still 'starting', or PowerShell stalls.
              enabled={enabled && (session.status === "starting" || session.status === "running")}
              onAttach={handleAttach}
              onDetach={handleDetach}
              onInputError={reportInputError}
            />
          ))
        )}
      </div>

      <div className="flex h-8 shrink-0 items-center justify-between border-t border-white/[0.06] bg-[#0d0906] px-3 text-[10px] text-slate-600">
        <span className="mono truncate">{cwd}</span>
        <Badge tone={enabled ? "orange" : "amber"}>
          {enabled ? "native PTY" : "web preview"}
        </Badge>
      </div>

      {error && (
        <div className="border-t border-rose-400/15 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-200">
          {error}
        </div>
      )}
    </div>
  );
}

function TerminalSurface({
  id,
  active,
  visible,
  fontSize,
  scrollback,
  cursorBlink,
  enabled,
  onAttach,
  onDetach,
  onInputError,
}: {
  id: string;
  active: boolean;
  visible: boolean;
  fontSize: number;
  scrollback: number;
  cursorBlink: boolean;
  enabled: boolean;
  onAttach: (id: string, handle: TerminalHandle) => void;
  onDetach: (id: string) => void;
  onInputError: (cause: unknown) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const terminalHandle = useRef<TerminalHandle | null>(null);
  const enabledRef = useRef(enabled);
  const activeRef = useRef(active);
  const visibleRef = useRef(visible);
  activeRef.current = active;
  visibleRef.current = visible;

  // Update synchronously with render: a native DSR request may arrive
  // before an effect would run when the shell enters "starting".
  enabledRef.current = enabled;

  const fitAndResize = useCallback(() => {
    const handle = terminalHandle.current;
    if (!handle || !activeRef.current || !visibleRef.current) return;
    try {
      handle.fit.fit();
      if (enabledRef.current) {
        void terminalResize(id, handle.terminal.cols, handle.terminal.rows)
          .catch(() => undefined);
      }
    } catch {
      // The host can temporarily be unmeasurable during navigation.
    }
  }, [id]);

  useEffect(() => {
    if (!host.current) return;

    const terminal = new Terminal({
      cursorBlink,
      convertEol: true,
      fontFamily: '"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, "Microsoft YaHei UI", monospace',
      fontSize,
      lineHeight: 1.3,
      letterSpacing: 0,
      minimumContrastRatio: 4.5,
      scrollback,
      theme: {
        background: "#090704",
        foreground: "#ebe3d8",
        cursor: "#fb923c",
        cursorAccent: "#090704",
        selectionBackground: "#7c2d1255",
        black: "#111827",
        brightBlack: "#a1a1aa",
        red: "#fb7185",
        green: "#6ee7b7",
        yellow: "#fcd34d",
        blue: "#fdba74",
        magenta: "#c4b5fd",
        cyan: "#67e8f9",
        white: "#e5e7eb",
        brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    terminalHandle.current = { terminal, fit };
    onAttach(id, terminalHandle.current);

    const input = terminal.onData((data) => {
      if (!enabledRef.current) return;
      void terminalWrite(id, new TextEncoder().encode(data)).catch(onInputError);
    });

    let resizeTimer: number | undefined;
    const resize = new ResizeObserver(() => {
      // Fitting display:none panes can collapse ConPTY to a 2-column terminal.
      if (!activeRef.current || !visibleRef.current) return;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(fitAndResize, 80);
    });
    resize.observe(host.current);

    return () => {
      window.clearTimeout(resizeTimer);
      resize.disconnect();
      input.dispose();
      onDetach(id);
      terminalHandle.current = null;
      terminal.dispose();
    };
  // Font changes update the existing instance below: never recreate the PTY
  // or discard its scrollback merely because the appearance changed.
  }, [id, onAttach, onDetach, onInputError, fitAndResize]);

  useEffect(() => {
    if (!active || !visible) return;
    // Re-fit and focus after a hidden tab becomes measurable again.
    const timer = window.setTimeout(() => {
      fitAndResize();
      terminalHandle.current?.terminal.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, visible, enabled, fitAndResize]);

  useEffect(() => {
    const handle = terminalHandle.current;
    if (!handle || handle.terminal.options.fontSize === fontSize) return;
    handle.terminal.options.fontSize = fontSize;
    // Hidden workspaces retain their buffers and apply the new geometry when
    // visited again; never resize a hidden ConPTY to a near-zero column count.
    if (!active || !visible) return;
    const timer = window.setTimeout(() => {
      fitAndResize();
      handle.terminal.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fontSize, active, visible, fitAndResize]);

  useEffect(() => {
    const terminal = terminalHandle.current?.terminal;
    if (!terminal) return;
    // Buffer/rendering options do not alter PTY geometry or take focus.
    terminal.options.scrollback = scrollback;
    terminal.options.cursorBlink = cursorBlink;
  }, [scrollback, cursorBlink]);

  return (
    <div
      className={cn("absolute inset-0 p-3", active ? "block" : "hidden")}
      ref={host}
    />
  );
}
