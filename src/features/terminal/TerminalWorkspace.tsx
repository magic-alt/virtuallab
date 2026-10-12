import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  Plus,
  Square,
  X,
  TerminalSquare,
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
import type { TerminalOutput, WorkbenchEvent } from "@/types/workbench";

interface Session {
  id: string;
  title: string;
  status: "starting" | "running" | "stopped" | "error";
}

interface TerminalHandle {
  terminal: Terminal;
  fit: FitAddon;
}

export function TerminalWorkspace({
  cwd,
  enabled,
  visible = true,
}: {
  cwd: string;
  enabled: boolean;
  visible?: boolean;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listenersReady, setListenersReady] = useState(false);
  const scope = workspaceKey(cwd);
  const handles = useRef(new Map<string, TerminalHandle>());
  const pending = useRef(new Map<string, number[][]>());
  const sessionsRef = useRef<Session[]>([]);
  sessionsRef.current = sessions;

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
          if (!sessionsRef.current.some((session) => session.id === payload.id)) return;
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
      // This cleanup is only for teardown/real workspace changes, not tab
      // navigation: WorkspaceContent keeps the terminal mounted.
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
    setSessions([]);
    setActiveId(null);
    setError(null);
  }, [scope]);

  const start = async () => {
    if (!enabled || !listenersReady || sessionsRef.current.length >= 8) return;

    const id =
      globalThis.crypto?.randomUUID?.() ??
      `terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const title = `Terminal ${sessions.length + 1}`;

    const next: Session[] = [...sessionsRef.current, { id, title, status: "starting" }];
    sessionsRef.current = next;
    setSessions(next);
    setActiveId(id);
    pending.current.set(id, []);
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
    <div className="vl-editor-surface mx-auto flex h-full min-h-[520px] max-w-[1320px] flex-col overflow-hidden rounded-2xl border border-white/[0.08] shadow-[4px_4px_0_rgba(58,16,0,0.55)]">
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

        <Button disabled={!enabled || !listenersReady || sessions.length >= 8} onClick={start} size="sm" variant="ghost">
          <Plus size={14} />
          New terminal
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
              <Button className="mt-5" disabled={!listenersReady} onClick={start}>
                <TerminalSquare size={14} />
                Start terminal
              </Button>
            )}
          </div>
        ) : (
          sessions.map((session) => (
            <TerminalSurface
              key={session.id}
              id={session.id}
              active={session.id === activeId}
              visible={visible}
              enabled={enabled && session.status === "running"}
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
  enabled,
  onAttach,
  onDetach,
  onInputError,
}: {
  id: string;
  active: boolean;
  visible: boolean;
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

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    if (!host.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 8000,
      theme: {
        background: "#090704",
        foreground: "#d9d3ca",
        cursor: "#fb923c",
        cursorAccent: "#090704",
        selectionBackground: "#7c2d1255",
        black: "#111827",
        brightBlack: "#6b7280",
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
      resizeTimer = window.setTimeout(() => {
        if (!activeRef.current || !visibleRef.current) return;
        try {
          fit.fit();
          if (enabledRef.current) {
            void terminalResize(id, terminal.cols, terminal.rows).catch(() => undefined);
          }
        } catch {
          // Ignore geometry changes during transitions.
        }
      }, 80);
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
  }, [id, onAttach, onDetach, onInputError]);

  useEffect(() => {
    if (!active || !visible) return;
    // Re-fit and focus after a hidden tab becomes measurable again.
    const timer = window.setTimeout(() => {
      const handle = terminalHandle.current;
      if (!handle) return;
      try {
        handle.fit.fit();
        if (enabled) {
          void terminalResize(id, handle.terminal.cols, handle.terminal.rows)
            .catch(() => undefined);
        }
        handle.terminal.focus();
      } catch {
        // The host may briefly have no measurable geometry on teardown.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [id, active, visible, enabled]);

  return (
    <div
      className={cn("absolute inset-0 p-3", active ? "block" : "hidden")}
      ref={host}
    />
  );
}
