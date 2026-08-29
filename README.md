# FastNote

FastNote是一个使用Tauri、React和TypeScript开发的跨平台笔记应用。

## 功能特性

- ✅ 笔记管理：创建、编辑、删除笔记
- ✅ 分类管理：创建、编辑、删除分类
- ✅ 拖拽排序：通过拖拽笔记到分类上快速切换分组
- ✅ 编辑器切换：支持Monaco Editor和Markdown Editor
- ✅ 笔记导出：支持多种格式导出
- ✅ 实时保存：自动保存笔记内容
- ✅ 分类选择：通过下拉菜单选择笔记分类
- ✅ 搜索功能：支持按标题和内容搜索笔记
- ✅ 排序功能：支持按更新时间、创建时间和标题排序

## 技术栈

- **前端**：React + TypeScript + Vite
- **桌面应用**：Tauri
- **编辑器**：Monaco Editor + md-editor-rt
- **样式**：Tailwind CSS

## 开发环境设置

### 推荐IDE

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

### 安装依赖

```bash
pnpm install
```

### 开发模式

```bash
pnpm tauri:dev
```

### 构建应用

```bash
pnpm tauri:build
```

## 使用说明

1. **创建笔记**：点击右上角的"+"按钮创建新笔记
2. **编辑笔记**：在编辑器中输入内容，自动保存
3. **分类管理**：在侧边栏管理分类，支持创建、编辑和删除
4. **拖拽分类**：将笔记拖拽到分类上快速切换分组
5. **切换编辑器**：点击编辑器切换按钮在Monaco Editor和Markdown Editor之间切换
6. **导出笔记**：点击导出按钮导出笔记为多种格式
7. **搜索笔记**：在搜索框中输入关键词搜索笔记
8. **排序笔记**：通过排序下拉菜单选择排序方式

## 项目结构

```
FastNote/
├── src/
│   ├── components/        # React组件
│   ├── config/            # 配置文件
│   ├── api/               # API调用
│   ├── types/             # TypeScript类型定义
│   ├── App.tsx            # 主应用组件
│   └── main.tsx           # 应用入口
├── public/                # 静态资源
├── src-tauri/             # Tauri后端
├── package.json           # 项目配置
├── tsconfig.json          # TypeScript配置
└── README.md              # 项目说明
```
