const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cs: "csharp",
  java: "java",
  go: "go",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  xml: "xml",
  svg: "xml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  sql: "sql",
};

export function reviewLanguage(path: string) {
  const file = path.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? "";
  if (file === "dockerfile") return "dockerfile";
  if (file === "makefile") return "plaintext";
  const dot = file.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  return LANGUAGE_BY_EXTENSION[file.slice(dot + 1)] ?? "plaintext";
}
