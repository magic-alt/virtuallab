import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
const backend = vi.hoisted(() => ({ analyzeCleanup: vi.fn(), cancelCleanupAnalysis: vi.fn(), previewCleanup: vi.fn() }));
vi.mock("@/lib/gitCleanup", () => backend);
import { CleanupReviewDialog } from "./CleanupReviewDialog";
const plan = { repositoryRoot: "/repo", selectedWorkspace: "/repo", baseRef: "refs/heads/trunk", baseSha: "a".repeat(40), originUrl: null, pushUrl: null, originDefaultBranch: "trunk", originDefaultSha: null,
  targets: [{ branch: "feat/done", localSha: "b".repeat(40), remoteSha: "b".repeat(40), worktreePath: null }], skipped: ["feat/keep: unmerged"] };
const result = { plan, report: { summary: "仅清理已合并分支", recommendations: [{ branch: "feat/done", recommendation: "delete", reason: "已合入 trunk", risk: "远端删除影响协作者" }] } };
function props() { return { repositoryRoot: "/repo", workspaceRoot: "/repo", revision: 1, onClose: vi.fn(), onExecute: vi.fn().mockResolvedValue(true) }; }
describe("cleanup review", () => {
  beforeEach(() => { vi.resetAllMocks(); backend.analyzeCleanup.mockResolvedValue(result); backend.cancelCleanupAnalysis.mockResolvedValue(undefined); });
  it("shows conclusions but requires explicit independent selection before execution", async () => {
    const p = props(); const user = userEvent.setup(); render(<CleanupReviewDialog {...p} />);
    await screen.findByText("仅清理已合并分支");
    expect(screen.getByRole("button", { name: "确认所选清理…" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "feat/done 本地分支" }));
    expect(screen.getByRole("checkbox", { name: "feat/done 远端分支" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "确认所选清理…" }));
    expect(p.onExecute).toHaveBeenCalledWith(plan, [{ branch: "feat/done", local: true, remote: false, worktree: false }]);
  });
  it("never silently falls back when Codex fails", async () => {
    backend.analyzeCleanup.mockRejectedValue(new Error("Codex unavailable")); const user = userEvent.setup(); render(<CleanupReviewDialog {...props()} />);
    await screen.findByText("Codex unavailable"); expect(backend.previewCleanup).not.toHaveBeenCalled();
    backend.previewCleanup.mockResolvedValue(plan);
    await user.click(screen.getByRole("button", { name: "使用规则预览" }));
    await screen.findByText("规则预览（未经 Codex 分析）");
    expect(screen.getByRole("button", { name: "确认所选清理…" })).toBeDisabled();
  });
  it("invalidates a displayed report on refresh", async () => {
    const p = props(); const view = render(<CleanupReviewDialog {...p} />); await screen.findByText("仅清理已合并分支");
    view.rerender(<CleanupReviewDialog {...p} revision={2} />);
    await screen.findByText("仓库已刷新，请重新排查。");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
  it("cancels its operation on close and ignores late analysis", async () => {
    let finish!: (value: typeof result) => void;
    backend.analyzeCleanup.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const p = props(); const user = userEvent.setup(); const view = render(<CleanupReviewDialog {...p} />);
    await waitFor(() => expect(backend.analyzeCleanup).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "取消排查" }));
    expect(backend.cancelCleanupAnalysis).toHaveBeenCalled();
    view.unmount(); await act(async () => { finish(result); });
    expect(p.onExecute).not.toHaveBeenCalled();
  });
});
