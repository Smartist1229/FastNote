import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

import { config } from 'md-editor-rt';
import screenfull from 'screenfull';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import Cropper from 'cropperjs';
import 'cropperjs/dist/cropper.css';
import mermaid from 'mermaid';
import highlight from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css';
import * as prettier from 'prettier';
import parserMarkdown from 'prettier/plugins/markdown';
import * as echarts from 'echarts';

config({
  // font-class引用
  // iconfontType: 'class',
  editorExtensions: {
    prettier: {
      prettierInstance: prettier,
      parserMarkdownInstance: parserMarkdown
    },
    highlight: {
      instance: highlight
    },
    screenfull: {
      instance: screenfull
    },
    katex: {
      instance: katex
    },
    cropper: {
      instance: Cropper
    },
    mermaid: {
      instance: mermaid
    },
    echarts: {
      instance: echarts
    }
  },
});

// 禁用 Ctrl+P 原生打印
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
    e.preventDefault();
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
