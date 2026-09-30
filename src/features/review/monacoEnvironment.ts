import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import jsonWorker from "monaco-editor/languages/features/json/json.worker.js?worker";
import cssWorker from "monaco-editor/languages/features/css/css.worker.js?worker";
import htmlWorker from "monaco-editor/languages/features/html/html.worker.js?worker";
import tsWorker from "monaco-editor/languages/features/typescript/ts.worker.js?worker";

type MonacoWorkerEnvironment = {
  getWorker: (moduleId: string, label: string) => Worker;
};

const target = globalThis as typeof globalThis & {
  MonacoEnvironment?: MonacoWorkerEnvironment;
};

target.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });

export { monaco };
