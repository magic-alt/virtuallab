import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { HelpCenter } from "./HelpCenter";

describe("in-app illustrated user guide", () => {
  it("opens offline without an active repository, with an illustration and semantic navigation", () => {
    render(<HelpCenter />);
    expect(screen.getByTestId("help-center")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "快速入门" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "帮助中心章节导航" })).toBeInTheDocument();
    const images = screen.getAllByRole("img");
    expect(images.some((item) => item.getAttribute("src")?.startsWith("/help/"))).toBe(true);
    expect(images.every((item) => Boolean(item.getAttribute("alt")))).toBe(true);
  });

  it("searches example text, opens an article and navigates forward", async () => {
    const user = userEvent.setup();
    render(<HelpCenter />);
    await user.type(screen.getByRole("textbox", { name: "搜索帮助内容" }), "Keil");
    expect(screen.getByText(/篇相关内容/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "一键构建与 Run" }));
    expect(screen.getByRole("heading", { name: "一键构建与 Run" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "搜索帮助内容" })).toHaveValue("");
    const article = screen.getByRole("article");
    expect(within(article).getByText("案例 C：Keil MDK 固件")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /下一章/ }));
    expect(screen.getByRole("heading", { name: "Terminal、Checks 与 History" })).toBeInTheDocument();
  });

  it("shows a recoverable no-results state", async () => {
    const user = userEvent.setup();
    render(<HelpCenter />);
    await user.type(screen.getByRole("textbox", { name: "搜索帮助内容" }), "zzzz-unused-phrase");
    expect(screen.getByText(/没有找到匹配内容/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(screen.getByRole("button", { name: "快速入门" })).toBeInTheDocument();
  });

  it("opens the end-to-end tutorial from the hero without requiring a provider", async () => {
    const user = userEvent.setup();
    render(<HelpCenter />);
    await user.click(screen.getByRole("button", { name: /查看实战案例/ }));
    expect(screen.getByRole("heading", { name: "端到端实践案例" })).toBeInTheDocument();
    expect(within(screen.getByRole("article")).getByRole("heading", { name: "案例 2 · 第三方 Qt 工程交付前编译" })).toBeInTheDocument();
  });
});
