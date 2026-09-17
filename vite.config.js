import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
      ignored: ["**/src-tauri/**"],
    },
  },
  // 解析低层需求 Excel 的 Worker 以 ES module 形式打包，
  // 保证 Tauri WebView2 与现代浏览器均支持，且能正确 bundle xlsx-js-style 依赖
  worker: {
    format: "es",
  },
});