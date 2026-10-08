import { useEffect, useState } from "react";
import { GitBranchPlus, X } from "lucide-react";
import { Button } from "@/components/ui/Button";

export function NewWorkspaceDialog({
  defaultBaseRef,
  defaultBranch = "",
  reviewLabel,
  onClose,
  onCreate,
}: {
  defaultBaseRef: string;
  defaultBranch?: string;
  reviewLabel?: string;
  onClose: () => void;
  onCreate: (branch: string, baseRef: string, targetPath?: string) => Promise<void>;
}) {
  const [branch, setBranch] = useState(defaultBranch);
  const [baseRef, setBaseRef] = useState(defaultBaseRef || "HEAD");
  const [targetPath, setTargetPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBaseRef(defaultBaseRef || "HEAD");
  }, [defaultBaseRef]);

  const submit = async () => {
    if (!branch.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(branch.trim(), baseRef.trim() || "HEAD", targetPath.trim() || undefined);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm">
      <div className="vl-dialog w-[560px] rounded-2xl border p-5 shadow-2xl">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 text-slate-100">
              <GitBranchPlus size={17} className="text-orange-300" />
              <h2 className="m-0 text-base font-semibold">New workspace</h2>
            </div>
            <p className="mb-0 mt-2 text-xs leading-5 text-slate-600">
              {reviewLabel
                ? `Prepare a dedicated ${reviewLabel} worktree. This creates a local branch from the chosen base ref; it does not fetch or check out remote PR code automatically.`
                : "Creates an isolated Git worktree and a new branch. Leave target empty to use VirtualLab's managed sibling workspace directory."}
            </p>
          </div>
          <button aria-label="Close new workspace dialog" className="rounded-lg p-2 text-slate-600 hover:bg-white/[0.05]" onClick={onClose} type="button">
            <X size={15} />
          </button>
        </div>

        <div className="mt-5 space-y-3">
          <Field label="Branch">
            <input className="field mono" autoFocus value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="feat/my-workspace" />
          </Field>
          <Field label="Base ref">
            <input className="field mono" value={baseRef} onChange={(event) => setBaseRef(event.target.value)} placeholder="main / HEAD / origin/main" />
          </Field>
          <Field label="Target path · optional">
            <input className="field mono" value={targetPath} onChange={(event) => setTargetPath(event.target.value)} placeholder="Auto: ../.virtuallab-workspaces/<repo>/<branch>" />
          </Field>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-rose-400/15 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-200">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">Cancel</Button>
          <Button disabled={!branch.trim() || busy} onClick={() => void submit()}>
            {busy ? "Creating…" : "Create workspace"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-medium text-slate-500">{label}</span>
      {children}
    </label>
  );
}
