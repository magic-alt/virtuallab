import path from "node:path";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "./dompurify/dompurify.js": path.resolve(__dirname, "./node_modules/dompurify/dist/purify.es.mjs"),
    },
  },
  test: {
    exclude: [...configDefaults.exclude, "**/.virtuallab/**", "**/.local-backups/**"],
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "http://localhost:1420/",
      },
    },
    setupFiles: ["./src/test/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
