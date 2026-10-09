import { useEffect, useRef, useState, type RefObject } from "react";
import { BookOpen, ChevronDown, CircleHelp } from "lucide-react";

interface Props {
  onOpenGuide: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

/** App-level menu: documentation is never a repository/worktree tab. */
export function HelpMenu({ onOpenGuide, triggerRef }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    firstItemRef.current?.focus();
    const onOutsidePress = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onOutsidePress);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onOutsidePress);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open, triggerRef]);

  return (
    <div className="relative shrink-0" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="flex h-8 items-center gap-1.5 rounded border border-transparent px-2.5 text-xs font-semibold text-orange-100 transition hover:border-orange-300/30 hover:bg-orange-950/40"
      >
        <CircleHelp size={14} aria-hidden="true" />
        Help
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Help"
          className="absolute left-0 top-[calc(100%+6px)] z-50 min-w-52 rounded border border-orange-300/40 bg-[#512008] p-1 shadow-2xl"
        >
          <button
            ref={firstItemRef}
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenGuide();
            }}
            className="flex w-full items-center gap-2 rounded px-3 py-2.5 text-left text-xs text-orange-50 transition hover:bg-orange-400/20 focus:bg-orange-400/20"
          >
            <BookOpen size={15} aria-hidden="true" />
            <span className="flex-1">使用文档</span>
            <span className="text-[10px] text-orange-200/60">Offline</span>
          </button>
        </div>
      )}
    </div>
  );
}
