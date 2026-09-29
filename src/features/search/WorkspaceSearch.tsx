import { Search, X } from "lucide-react";
import { useEffect, useRef } from "react";

export function WorkspaceSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      } else if (event.key === "Escape" && document.activeElement === inputRef.current) {
        onChange("");
        inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onChange]);

  return (
    <label className="vl-search flex h-8 items-center gap-2 px-3 text-xs">
      <Search size={13} className="text-orange-200" />
      <input
        ref={inputRef}
        aria-label="Search repositories and workspaces"
        className="min-w-0 flex-1"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search repositories / workspaces"
      />
      {value ? (
        <button
          aria-label="Clear search"
          className="p-0.5 text-orange-200 hover:text-white"
          onClick={() => onChange("")}
          type="button"
        >
          <X size={12} />
        </button>
      ) : (
        <span className="mono border border-orange-300/30 bg-orange-950/30 px-1.5 py-0.5 text-[9px] text-orange-100">
          Ctrl K
        </span>
      )}
    </label>
  );
}
