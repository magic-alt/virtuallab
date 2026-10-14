import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Monaco is loaded on demand and served locally in the desktop app. Keep its
// budget separate so its size does not hide growth in ordinary UI chunks.
const monacoChunkBudgetKb = 4500;
function desktopChunkBudgets(): Plugin {
  return {
    name: "desktop-chunk-budgets",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        const budgetKb = output.name === "monaco-core" ? monacoChunkBudgetKb : 500;
        const size = Buffer.byteLength(output.code, "utf8");
        if (size > budgetKb * 1000) {
          this.error(`${output.fileName} exceeds its ${budgetKb} kB desktop chunk budget (${size} bytes)`);
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), desktopChunkBudgets()],
  build: {
    // Per-chunk limits above enforce 500 kB for the UI and a separate budget
    // for the lazy editor, rather than applying Monaco's allowance globally.
    chunkSizeWarningLimit: monacoChunkBudgetKb,
    rollupOptions: {
      output: {
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          const modulePath = id.replace(/\\/g, "/");
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(modulePath)) return "react-vendor";
          if (modulePath.includes("/node_modules/@xterm/")) return "terminal-vendor";
          // Monaco calls DOMPurify through its trusted-types adapter, which
          // also imports Monaco utilities. Keep both sides in the same chunk.
          if (modulePath.includes("/node_modules/dompurify/")) return "monaco-core";
          // Root helpers such as amdX/nls import and are imported by the core;
          // keep that cycle together while language modules remain lazy.
          if (/\/node_modules\/monaco-editor\/esm\/vs\/((base|editor|platform)\/|(amdX|nls)\.js($|\?))/.test(modulePath)) {
            return "monaco-core";
          }
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Monaco ships an embedded older copy; npm overrides alone do not replace it.
      "./dompurify/dompurify.js": path.resolve(__dirname, "./node_modules/dompurify/dist/purify.es.mjs"),
    },
  },
  optimizeDeps: {
    // esbuild prebundling bypasses relative aliases; serve Monaco through Vite instead.
    exclude: ["monaco-editor"],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
