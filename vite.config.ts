import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  /*
   * Tailwind 走它自己的 Vite 插件，而不是 PostCSS 插件。
   *
   * PostCSS 那条路在 dev 里拿不到 `from`（源码文件路径），Vite 会报
   * "A PostCSS plugin did not pass the `from` option to `postcss.parse`"，
   * 之后 `@config` 与 `content` 的相对路径就没有基准目录，扫描不到源码 →
   * 原子类整批缺失（页面只剩 App.css 手写的那层骨架）。
   * Vite 插件直接接管模块图，扫描与 HMR 都跟着 dev server 走。
   */
  plugins: [react(), tailwindcss()],

  resolve: { alias: { "@": path.resolve(__dirname, "src") } },

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
    // 桌面端资源从本地磁盘读取，modulepreload 提示没有收益
    modulePreload: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // Vite 的动态 import 辅助函数是虚拟模块，任何懒加载都会静态引用它。
            // 必须单独成块：跟 mermaid 合并会把整座图表库拖进首屏。
            { name: "vendor-vite", test: /vite[\\/]preload-helper/, priority: 40, minSize: 0 },
            { name: "vendor-react", test: /node_modules[\\/](react|react-dom)[\\/]/, priority: 20 },
            { name: "vendor-tauri", test: /node_modules[\\/]@tauri-apps[\\/]/, priority: 20 },
            // mermaid / katex 不并入固定分组：让 bundler 保留包内的动态拆分，
            // 只有真正用到某类图表时才下载对应分片。
          ],
        },
      },
    },
  },
}));
