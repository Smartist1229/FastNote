import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;

          const path = id.replace(/\\/g, "/");

          if (path.includes("/react/") || path.includes("/react-dom/")) {
            return "vendor-react";
          }
          if (path.includes("/@tauri-apps/")) {
            return "vendor-tauri";
          }
          if (path.includes("/@monaco-editor/react/")) {
            return "editor-monaco-react";
          }
          if (path.includes("/monaco-editor/")) {
            return "editor-monaco";
          }
          if (path.includes("/md-editor-rt/")) {
            return "editor-markdown";
          }
          if (path.includes("/mermaid/") || path.includes("/cytoscape") || path.includes("/dagre")) {
            return "markdown-diagrams";
          }
          if (path.includes("/katex/")) {
            return "markdown-math";
          }
          if (path.includes("/highlight.js/")) {
            return "markdown-highlight";
          }
          if (path.includes("/prettier/")) {
            return "markdown-format";
          }
          if (path.includes("/echarts/") || path.includes("/zrender/")) {
            return "markdown-charts";
          }
          if (path.includes("/cropperjs/") || path.includes("/screenfull/")) {
            return "markdown-tools";
          }

          return undefined;
        },
      },
    },
  },
}));
