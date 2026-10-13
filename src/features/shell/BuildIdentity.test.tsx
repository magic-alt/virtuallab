import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { BuildIdentity } from "./BuildIdentity";
import { getAppBuildInfo, isDesktopRuntime } from "@/lib/backend";
import type { AppBuildInfo } from "@/types/appBuild";

vi.mock("@/lib/backend", () => ({ getAppBuildInfo: vi.fn(), isDesktopRuntime: vi.fn() }));
const info: AppBuildInfo = {
  version: "0.5.0", gitCommit: "1234567890abcdef1234567890abcdef12345678",
  gitBranch: "feat/build-provenance", gitDirty: true, builtAtUnixSeconds: 1791849600,
  profile: "release",
};
beforeEach(() => {
  vi.mocked(isDesktopRuntime).mockReturnValue(true);
  vi.mocked(getAppBuildInfo).mockResolvedValue(info);
});

it("shows the executable commit and dirty marker, with source details on click", async () => {
  const user = userEvent.setup();
  render(<BuildIdentity />);
  const button = await screen.findByRole("button", { name: /1234567890ab.*dirty/i });
  await user.click(button);
  expect(screen.getByText("1234567890abcdef1234567890abcdef12345678")).toBeVisible();
  expect(screen.getByText("feat/build-provenance")).toBeVisible();
  expect(screen.getByText("Release")).toBeVisible();
  expect(screen.getByText("2026-10-13T00:00:00.000Z")).toBeVisible();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(button).toHaveFocus();
});

it("does not present failed native metadata as a known build", async () => {
  vi.mocked(getAppBuildInfo).mockRejectedValue(new Error("unavailable"));
  render(<BuildIdentity />);
  expect(await screen.findByRole("button", { name: /构建信息不可用/ })).toBeVisible();
});

it("labels browser preview rather than displaying desktop build provenance", () => {
  vi.mocked(isDesktopRuntime).mockReturnValue(false);
  render(<BuildIdentity />);
  expect(screen.getByText(/浏览器预览/)).toBeVisible();
});

it("shows unknown Git status distinctly from a clean checkout", async () => {
  vi.mocked(getAppBuildInfo).mockResolvedValue({ ...info, gitCommit: null, gitBranch: null, gitDirty: null, profile: "debug" });
  const user = userEvent.setup();
  render(<BuildIdentity />);
  await user.click(await screen.findByRole("button", { name: /Git 未知/ }));
  expect(screen.getByText("修改状态未知")).toBeVisible();
  expect(screen.getByText("Debug")).toBeVisible();
});
