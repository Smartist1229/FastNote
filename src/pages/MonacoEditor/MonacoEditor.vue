<template>
  <div ref="editorContainer" class="editor-container"></div>
</template>

<script lang="ts">
export default {
  name: "MonacoEditor",
};
</script>

<script lang="ts" setup>
import { ref, onMounted, onBeforeUnmount } from "vue";
import * as monaco from "monaco-editor";
import emitter from "../../utils/emitter";

const editorContainer = ref<any>(null);
let editorInstance: any;

onMounted(() => {
  // 当组组件挂载后，创建 Monaco 编辑器实例
  editorInstance = monaco.editor.create(editorContainer.value, {
    value: "", // 内容初始值为空
    language: "plaintext", // 默认语言
    theme: "vs-light", // 主题
    automaticLayout: true, // 自动布局
    minimap: { enabled: false }, // 关闭小地图
    wordWrap: "on", // 自动换行
    lineNumbers: "on", // 显示行号
    lineDecorationsWidth: 0, // 行装饰
    wrappingIndent: "none", // 行缩进
    lineNumbersMinChars: 3, // 行号最小宽度
    fontSize: 14, // 字体大小
    fontFamily: "inherit", // 设置字体
    selectOnLineNumbers: true, // 点击行号时选中行
    folding: true, // 代码折叠
    overviewRulerLanes: 0, // 隐藏概览 ruler(语法高亮)
    contextmenu: false, // 右键菜单
    acceptSuggestionOnCommitCharacter: false, // 禁用自动完成功能
    quickSuggestions: false, // 快速提示功能
    acceptSuggestionOnEnter: "off", // 回车键自动完成功能
    accessibilitySupport: "on", // 辅助功能(优化阅读)
    autoClosingBrackets: "always", // 自动关闭括号
    autoClosingDelete: "always", // 删除时自动关闭括号
    autoClosingOvertype: "never", // 覆盖模式下自动关闭括号
    autoClosingQuotes: "always", // 自动关闭引号
    codeLens: false, // 代码提示功能
    columnSelection: false, // 多列选择功能
    cursorSmoothCaretAnimation: "on", // 光标平滑移动动画
    links: true, // 跳转链接功能
    stickyScroll: { enabled: false }, // 粘性滚动功能
    mouseWheelZoom: true, // 鼠标滚轮缩放功能
    unicodeHighlight:{
      allowedCharacters: {}, // 允许的字符列表
      allowedLocales: {}, // 允许的语言列表
      ambiguousCharacters: false, // 非基本 ASCII 符号高亮
      includeComments: false, // 注释高亮
      invisibleCharacters: false, // 不可见字符高亮
      nonBasicASCII: false, // 非基本 ASCII 字符高亮
    },
    selectionHighlight: true, // 选中高亮
    renderLineHighlight: "all", // 显示选中行高亮
    renderLineHighlightOnlyWhenFocus: false, // 仅在编辑器获取焦点时才显示选中行高亮
    suggestLineHeight: 0, // 提示行高度
  });

  // 监听编辑器内容变化事件
  editorInstance.onDidChangeModelContent(() => {
    const newValue = editorInstance.getValue();
    emitter.emit("contentChange", newValue);
  });

  // 在组件挂载后注册事件监听器
  emitter.on("noteContent", (content) => {
    if (editorInstance) {
      editorInstance.setValue(content);
    }
  });

  // 监听 content 的变化
  emitter.on('newContent', (newValue) => {
    if (editorInstance) {
      editorInstance.setValue(newValue);
    }
  });

});

onBeforeUnmount(() => {
  if (editorInstance) {
    editorInstance.dispose();
  }
});



</script>

<style scoped>
.editor-container {
  width: 100%;
  height: 100%;
}
</style>
