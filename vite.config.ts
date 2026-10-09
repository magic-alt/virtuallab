import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
