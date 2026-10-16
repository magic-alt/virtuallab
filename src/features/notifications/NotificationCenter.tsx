import { useState } from "react";
import { Bell, BellOff, CheckCheck, X } from "lucide-react";
import { useTaskNotifications, type TaskNotice } from "@/stores/taskNotifications";

export function NotificationCenter({ onNavigate }: {
  onNavigate: (notice: TaskNotice) => void;
}) {
  const [open, setOpen] = useState(false);
  const notices = useTaskNotifications((s) => s.notices);
  const enabled = useTaskNotifications((s) => s.desktopEnabled);
  const error = useTaskNotifications((s) => s.desktopError);
  const setEnabled = useTaskNotifications((s) => s.setDesktopEnabled);
  const markRead = useTaskNotifications((s) => s.markRead);
  const clear = useTaskNotifications((s) => s.clear);
  const unread = notices.filter((n) => !n.read).length;
  return (
    <div className="relative shrink-0">
      <button type="button" aria-label={"Task notifications" + (unread ? " (" + unread + " unread)" : "")}
        aria-expanded={open} aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        className="relative flex size-8 items-center justify-center rounded-lg text-stone-400 hover:bg-white/[0.06] hover:text-orange-200">
        <Bell size={16} />
        {unread > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-orange-500 px-0.5 text-center text-[10px] text-black">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Task notifications"
          onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
          className="absolute right-0 top-10 z-50 flex w-[min(360px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-white/10 bg-[#15120f] shadow-2xl">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-3">
            <strong className="text-xs text-slate-200">Task notifications</strong>
            <div className="flex gap-1">
              <button type="button" title="Clear all" aria-label="Clear notifications" onClick={clear}
                className="rounded p-1.5 text-stone-400 hover:bg-white/5 hover:text-slate-100"><CheckCheck size={15} /></button>
              <button type="button" title="Close" aria-label="Close notifications" onClick={() => setOpen(false)}
                className="rounded p-1.5 text-stone-400 hover:bg-white/5 hover:text-slate-100"><X size={15} /></button>
            </div>
          </div>
          <button type="button" role="switch" aria-checked={enabled}
            onClick={() => setEnabled(!enabled)}
            className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5 text-left text-[11px] text-stone-300 hover:bg-white/5">
            {enabled ? <Bell size={13} /> : <BellOff size={13} />}
            Desktop alerts: {enabled ? "On" : "Off"}
            <span className="ml-auto text-[10px] text-stone-500">System toast</span>
          </button>
          {error && enabled && <p role="status" className="border-b border-amber-400/10 px-3 py-2 text-[11px] text-amber-200">
            System notifications unavailable: {error}. In-app alerts still work.
          </p>}
          <div className="max-h-80 overflow-y-auto">
            {notices.length === 0 && <p className="px-3 py-8 text-center text-xs text-stone-500">No task notifications yet.</p>}
            {notices.map((notice) => (
              <button type="button" key={notice.id}
                onClick={() => { markRead(notice.id); setOpen(false); onNavigate(notice); }}
                className="flex w-full items-start gap-2 border-b border-white/[0.04] px-3 py-3 text-left hover:bg-white/[0.04]">
                <span className={"mt-1 size-2 shrink-0 rounded-full " + (notice.read ? "bg-stone-700" : notice.severity === "failed" ? "bg-rose-400" : "bg-orange-400")} />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-slate-200">{notice.title}</span>
                  <span className="mt-1 block text-[11px] text-stone-400">{notice.detail}</span>
                  <span className="mt-1 block truncate text-[10px] text-stone-600" title={notice.workspaceRoot}>
                    {notice.workspaceRoot} · {new Date(notice.createdAt).toLocaleTimeString()}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
