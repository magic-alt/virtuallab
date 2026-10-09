import { useEffect, useRef, useState } from "react";
import appManifest from "../../../package.json";
import {
  ArrowLeft, ArrowRight, BookOpen, Bot, Check, ChevronRight, CircleHelp, Clock3,
  Copy, FileDiff, GitBranch, Github, Hammer, Layers3, LayoutDashboard, Lightbulb,
  Monitor, Rocket, Search, ShieldCheck, TerminalSquare, TriangleAlert, Workflow,
  X, type LucideIcon,
} from "lucide-react";
import {
  guideCategories, guidePages, searchGuidePages,
  type GuideBlock, type GuidePage,
} from "./guideContent";
import "./helpCenter.css";

const icons: Record<GuidePage["icon"], LucideIcon> = {
  start: Rocket,
  layout: LayoutDashboard,
  branch: GitBranch,
  review: FileDiff,
  build: Hammer,
  terminal: TerminalSquare,
  github: Github,
  agents: Bot,
  shield: ShieldCheck,
  examples: Workflow,
  help: CircleHelp,
  architecture: Layers3,
};

function ContentBlock({ block }: { block: GuideBlock }) {
  const [copied, setCopied] = useState<"idle" | "done" | "error">("idle");

  if (block.type === "text") {
    return <p className="vl-guide-text">{block.text}</p>;
  }
  if (block.type === "diagram") {
    return (
      <figure className="vl-guide-figure">
        <img src={block.src} alt={block.alt} loading="lazy" />
        <figcaption>{block.caption}</figcaption>
      </figure>
    );
  }
  if (block.type === "steps") {
    return (
      <ol className="vl-guide-steps">
        {block.items.map((item, index) => (
          <li key={index} className="vl-guide-step">
            <span className="vl-guide-step-number">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <strong>{item.title}</strong>
              <p>{item.description}</p>
            </div>
          </li>
        ))}
      </ol>
    );
  }
  if (block.type === "cards") {
    return (
      <div className="vl-guide-card-grid">
        {block.items.map((item) => (
          <div className="vl-guide-feature-card" key={item.title}>
            <span className="vl-guide-card-accent" />
            <h3>{item.title}</h3>
            <p>{item.description}</p>
          </div>
        ))}
      </div>
    );
  }
  if (block.type === "callout") {
    const WarningIcon = block.tone === "warning" ? TriangleAlert : Lightbulb;
    return (
      <aside className={"vl-guide-callout vl-guide-callout-" + block.tone}>
        <WarningIcon size={19} aria-hidden="true" />
        <div><strong>{block.title}</strong><p>{block.text}</p></div>
      </aside>
    );
  }
  if (block.type === "code") {
    async function copyCode() {
      try {
        await navigator.clipboard.writeText(block.type === "code" ? block.content : "");
        setCopied("done");
      } catch {
        setCopied("error");
      }
    }
    return (
      <div className="vl-guide-code">
        <div className="vl-guide-code-toolbar">
          <span>{block.label}</span>
          <div className="vl-guide-code-actions">
            <span>{block.language.toUpperCase()}</span>
            <button type="button" onClick={() => void copyCode()} aria-label={"复制 " + block.label}>
              {copied === "done" ? <Check size={14} /> : <Copy size={14} />}
              {copied === "done" ? "已复制" : "复制"}
            </button>
          </div>
        </div>
        <pre><code>{block.content}</code></pre>
        {copied === "error" && <p className="vl-guide-copy-error" role="status">复制失败，请手动选择代码。</p>}
      </div>
    );
  }
  if (block.type === "table") {
    return (
      <div className="vl-guide-table-wrap" role="region" aria-label="说明表格" tabIndex={0}>
        <table className="vl-guide-table">
          <thead><tr>{block.columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((value, colIndex) => <td key={colIndex}>{value}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <ul className="vl-guide-checklist">
      {block.items.map((item) => (
        <li key={item}><Check size={16} aria-hidden="true" /><span>{item}</span></li>
      ))}
    </ul>
  );
}

export function HelpCenter() {
  const [activeId, setActiveId] = useState("start");
  const [search, setSearch] = useState("");
  const articleScroll = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const activeIndex = Math.max(guidePages.findIndex((page) => page.id === activeId), 0);
  const page = guidePages[activeIndex];
  const matchingPages = searchGuidePages(search);

  useEffect(() => {
    if (articleScroll.current) articleScroll.current.scrollTop = 0;
  }, [activeId]);

  function selectPage(id: string) {
    setActiveId(id);
    setSearch("");
  }

  function jumpTo(id: string) {
    const section = articleScroll.current?.querySelector<HTMLElement>("[id='" + id + "']");
    if (section && articleScroll.current) {
      const top = section.getBoundingClientRect().top -
        articleScroll.current.getBoundingClientRect().top + articleScroll.current.scrollTop;
      articleScroll.current.scrollTo({ top: Math.max(0, top - 24), behavior: "smooth" });
    }
  }

  return (
    <div className="vl-guide" data-testid="help-center">
      <nav className="vl-guide-sidebar" aria-label="帮助中心章节导航">
        <div className="vl-guide-brand">
          <span className="vl-guide-brand-icon"><BookOpen size={21} /></span>
          <div>
            <div className="vl-guide-brand-name">VirtualLab <strong>Guide</strong></div>
            <p>工程工作台 · 使用手册</p>
          </div>
        </div>
        <label className="vl-guide-search">
          <Search size={16} aria-hidden="true" />
          <input ref={searchInput} value={search} onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索操作与案例..." aria-label="搜索帮助内容" />
          {search && <button type="button" aria-label="清除搜索" onClick={() => { setSearch(""); searchInput.current?.focus(); }}><X size={14} /></button>}
        </label>
        <div className="vl-guide-menu" aria-label="文章列表">
          {search.trim() ? (
            <>
              <div className="vl-guide-category">找到 {matchingPages.length} 篇相关内容</div>
              {matchingPages.map((item) => <PageButton key={item.id} page={item} active={item.id === page.id} onClick={() => selectPage(item.id)} />)}
              {matchingPages.length === 0 && (
                <div className="vl-guide-no-results">
                  没有找到匹配内容。试试 Git、Qt、Keil、PR 或 Agent。
                </div>
              )}
            </>
          ) : guideCategories.map((category) => (
            <div key={category}>
              <div className="vl-guide-category">{category}</div>
              {guidePages.filter((item) => item.category === category).map((item) => (
                <PageButton key={item.id} page={item} active={item.id === page.id} onClick={() => selectPage(item.id)} />
              ))}
            </div>
          ))}
        </div>
        <div className="vl-guide-offline">
          <span className="vl-guide-offline-dot" />
          <div><strong>OFFLINE READY</strong><p>文字与图片均随应用打包</p></div>
        </div>
      </nav>

      <div className="vl-guide-scroll" ref={articleScroll} aria-label="使用指南正文">
        <article className="vl-guide-article" key={page.id}>
          <div className="vl-guide-breadcrumb">
            <span>HANDBOOK</span><ChevronRight size={13} /><span>{page.category}</span><ChevronRight size={13} /><span>{page.title}</span>
          </div>
          {page.id === "start" && (
            <div className="vl-guide-hero">
              <div className="vl-guide-hero-pattern" aria-hidden="true">
                <span className="vl-guide-orbit vl-guide-orbit-one" />
                <span className="vl-guide-orbit vl-guide-orbit-two" />
                <span className="vl-guide-orbit vl-guide-orbit-three" />
                <span className="vl-guide-hero-glyph"><Layers3 size={56} strokeWidth={1.2} /></span>
              </div>
              <span className="vl-guide-hero-kicker">THE ENGINEERING FIELD GUIDE / V{appManifest.version}</span>
              <h1>从一个仓库，<br />到清晰的工程工作流。</h1>
              <p>理解 Git Worktree · 构建 · Review · Agent 的完整协作方式，把每一次修改放回可追溯的工作区。</p>
              <div className="vl-guide-hero-actions">
                <button type="button" onClick={() => selectPage("examples")}>查看实战案例 <ArrowRight size={16} /></button>
                <span>本机离线可读 · 无外部内容依赖</span>
              </div>
            </div>
          )}
          <header className="vl-guide-article-heading">
            <span className="vl-guide-overline"><span className="vl-guide-orange-line" /> {page.category}</span>
            <h1>{page.title}</h1>
            <p>{page.subtitle}</p>
            <div className="vl-guide-meta">
              <span><Clock3 size={14} /> {page.duration}</span>
              <span><Monitor size={14} /> 桌面版 / Web 预览均可阅读</span>
              <span>版本 {appManifest.version}</span>
            </div>
          </header>

          {page.sections.map((section, index) => (
            <section className="vl-guide-section" id={section.id} key={section.id}>
              <div className="vl-guide-section-heading">
                <span>{String(index + 1).padStart(2, "0")}</span>
                <h2>{section.title}</h2>
              </div>
              <div className="vl-guide-blocks">
                {section.blocks.map((block, blockIndex) =>
                  <ContentBlock block={block} key={section.id + "-" + blockIndex} />)}
              </div>
            </section>
          ))}

          <div className="vl-guide-page-nav">
            {activeIndex > 0 ? (
              <button type="button" className="vl-guide-prev" onClick={() => selectPage(guidePages[activeIndex - 1].id)}>
                <ArrowLeft size={16} /><span><small>上一章</small>{guidePages[activeIndex - 1].title}</span>
              </button>
            ) : <span />}
            {activeIndex + 1 < guidePages.length ? (
              <button type="button" className="vl-guide-next" onClick={() => selectPage(guidePages[activeIndex + 1].id)}>
                <span><small>下一章</small>{guidePages[activeIndex + 1].title}</span><ArrowRight size={16} />
              </button>
            ) : <span />}
          </div>
          <footer className="vl-guide-article-footer">
            VirtualLab Guide · 内容对应项目源码及 docs 文档。流程图为示意图，不包含实时仓库或设备数据。
          </footer>
        </article>
      </div>

      <aside className="vl-guide-outline" aria-label="本章目录">
        <div className="vl-guide-outline-heading">ON THIS PAGE</div>
        {page.sections.map((section) => (
          <button type="button" key={section.id} onClick={() => jumpTo(section.id)}>
            {section.title}
          </button>
        ))}
        <div className="vl-guide-outline-note">
          <BookOpen size={17} aria-hidden="true" />
          <strong>从代码到操作</strong>
          <p>章节含图解、参数示例、操作步骤和风险说明。</p>
        </div>
      </aside>
    </div>
  );
}

function PageButton({ page, active, onClick }: {
  page: GuidePage;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = icons[page.icon];
  return (
    <button type="button" className={"vl-guide-nav-item" + (active ? " is-active" : "")}
      aria-current={active ? "page" : undefined}
      onClick={onClick}>
      <Icon size={16} aria-hidden="true" />
      <span>{page.title}</span>
      {active && <ChevronRight size={14} aria-hidden="true" />}
    </button>
  );
}
