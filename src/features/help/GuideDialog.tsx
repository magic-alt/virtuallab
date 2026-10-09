import { useEffect, useRef, type KeyboardEvent } from "react";
import { BookOpen, X } from "lucide-react";
import { HelpCenter } from "./HelpCenter";

interface Props {
  onClose: () => void;
}

/** Full-window application reader; keep the workbench mounted underneath. */
export function GuideDialog({ onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="VirtualLab 使用文档"
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 flex min-h-0 min-w-0 flex-col bg-[#2c1307] p-2 sm:p-4"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-orange-300/30 shadow-2xl">
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-orange-300/30 bg-[#60290d] px-4">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-orange-50">
            <BookOpen size={17} aria-hidden="true" />
            <span>使用文档</span>
            <span className="hidden text-[11px] font-normal text-orange-200/60 sm:inline">VirtualLab Help Center · 离线可用</span>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="关闭文档"
            onClick={onClose}
            className="flex h-8 items-center gap-1.5 rounded border border-orange-300/30 px-2.5 text-xs font-semibold text-orange-100 transition hover:bg-orange-950/40"
          >
            <X size={15} aria-hidden="true" />
            <span>关闭</span>
          </button>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <HelpCenter />
        </div>
      </div>
    </div>
  );
}
