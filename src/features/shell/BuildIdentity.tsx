import { useEffect, useRef, useState } from "react";
import appManifest from "../../../package.json";
import { getAppBuildInfo, isDesktopRuntime } from "@/lib/backend";
import type { AppBuildInfo } from "@/types/appBuild";

export function BuildIdentity() {
  const [info, setInfo] = useState<AppBuildInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const desktop = isDesktopRuntime();

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void getAppBuildInfo().then(
      (value) => { if (!cancelled) setInfo(value); },
      () => { if (!cancelled) setFailed(true); },
    );
    return () => { cancelled = true; };
  }, [desktop]);

  useEffect(() => { if (open) closeRef.current?.focus(); }, [open]);
  const close = () => { setOpen(false); triggerRef.current?.focus(); };

  if (!desktop) return <span className="mono shrink-0 text-orange-300/70">VirtualLab v{appManifest.version} · 浏览器预览</span>;
  const identity = info
    ? `VirtualLab v${info.version} · ${info.gitCommit?.slice(0, 12) ?? "Git 未知"}${info.gitDirty === true ? " · dirty" : info.gitDirty === null ? " · 状态未知" : ""}`
    : failed ? "VirtualLab · 构建信息不可用" : "VirtualLab · 正在读取构建信息…";

  return (
    <div className="relative min-w-0 max-w-[65%]">
      <button ref={triggerRef} type="button" aria-haspopup="dialog" aria-expanded={open}
        disabled={!info && !failed} onClick={() => open ? close() : setOpen(true)}
        title="查看当前程序的构建来源" className="mono block max-w-full truncate rounded px-1 text-orange-300/80 hover:text-orange-100 focus-visible:outline focus-visible:outline-orange-300">
        {identity}
      </button>
      {open && (
        <section role="dialog" aria-label="当前程序构建信息"
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}
          className="absolute bottom-8 right-0 z-50 max-h-[calc(100dvh-4rem)] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-orange-300/30 bg-[#2c1307] p-4 text-xs text-orange-50 shadow-2xl">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">当前程序构建信息</h2>
            <button ref={closeRef} type="button" onClick={close} className="rounded border border-orange-300/30 px-2 py-1">关闭</button>
          </div>
          {info ? (
            <>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
                <dt>应用版本</dt><dd>v{info.version}</dd>
                <dt>Git 提交</dt><dd className="mono break-all select-text">{info.gitCommit ?? "未知（构建时无 Git 信息）"}</dd>
                <dt>Git 分支</dt><dd className="mono break-all select-text">{info.gitBranch ?? "未知"}</dd>
                <dt>源码状态</dt><dd>{info.gitDirty === null ? "修改状态未知" : info.gitDirty ? "含未提交修改（dirty）" : "干净（clean）"}</dd>
                <dt>构建时间 UTC</dt><dd className="mono break-all select-text">{new Date(info.builtAtUnixSeconds * 1000).toISOString()}</dd>
                <dt>构建模式</dt><dd>{info.profile === "debug" ? "Debug" : "Release"}</dd>
              </dl>
              <p className="mt-3 border-t border-orange-300/20 pt-3 leading-relaxed text-orange-200/70">以上信息来自当前可执行文件的编译记录，与选中的工作区无关。dirty 表示编译时包含未提交修改，提交号不能完整代表该程序的源码。</p>
            </>
          ) : <p>无法读取当前程序的编译记录。请重新构建并启动桌面程序。</p>}
        </section>
      )}
    </div>
  );
}
