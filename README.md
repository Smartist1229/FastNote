# FastNote

一个使用 Tauri + React + TypeScript 开发的跨平台笔记应用，内置可调用工具的 AI 笔记助手。

## 功能

- **AI 笔记助手**：25 个内置工具（查找、写入、按行编辑、删除、分组、导航），支持深度思考、工具轨迹、上下文压缩
- **笔记管理**：创建、编辑、删除笔记，实时自动保存，拖拽归类
- **分组管理**：创建、编辑、删除分组，支持未分类
- **回收站**：删除进回收站可还原，30 天后自动清理
- **双编辑器**：Monaco Editor 与 Markdown 编辑器一键切换
- **导出**：笔记导出为文件
- **搜索与排序**：按标题/内容搜索，按时间/标题排序
- **欢迎面板**：统计概览与最近笔记

## 构建

```bash
pnpm install          # 安装依赖
pnpm tauri:dev         # 开发模式（桌面端）
pnpm tauri:build       # 打包桌面应用
```

## 技术栈

- 前端：React 19 + TypeScript + Vite + Tailwind CSS
- 桌面端：Tauri 2 (Rust 后端)
- 编辑器：Monaco Editor + md-editor-rt
- 数据库：SQLite (AI 设置加密存储 + 笔记数据)