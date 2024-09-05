import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import electron from 'vite-plugin-electron';
import path from 'path';

export default defineConfig({
  define: {
    // 关闭Options Api
    '__VUE_OPTIONS_API__': false,
    '__VUE_PROD_DEVTOOLS__': process.env.NODE_ENV !== 'production'
  },
  plugins: [
    vue(),
    electron({
      entry: './electron/main.js'
    })
  ],
  server: {
    port: 4000 // 确保 Vite 开发服务器在端口 4000 运行
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
