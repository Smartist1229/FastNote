<template>
  <div class="main-window">
    <classBox></classBox>
    <itemListBox></itemListBox>
    <editContentBox></editContentBox>
  </div>
</template>

<script lang="ts">
export default {
  name: "App",
};
</script>

<script lang="ts" setup>
import classBox from './pages/classBox/classBox.vue'
import itemListBox from './pages/itemListBox/itemListBox.vue'
import editContentBox from './pages/editContentBox/editContentBox.vue'

</script>

<style>
@font-face {
  font-family: "iconfont";
  src: url("@/assets/font/ali/iconfont.woff2?t=1722092595666") format("woff2"),
    url("@/assets/font/ali/iconfont.woff?t=1722092595666") format("woff"),
    url("@/assets/font/ali/iconfont.ttf?t=1722092595666") format("truetype");
}
@font-face {
  font-family: "Monaco";
  src: url("@/assets/font/monaco.ttf") format("truetype");
  font-weight: normal;
  font-style: normal;
}
* {
  margin: 0;
  padding: 0;
  font-family: Monaco, "微软雅黑";
}
/* 主容器 */
.main-window {
  height: 100vh;
  width: 100vw;
  display: flex;
  background-color: #dbd9d956;
}

/* 选中样式 */
.active {
  background-color: #7a7a7a67;
}
.activeClass {
  background-color: #fdcf0067;
}

/* 阿里文字图标 */
.iconfont {
  font-family: "iconfont" !important;
  font-size: 16px;
  font-style: normal;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* 选中样式 */
::selection{
  background-color: rgba(0, 0, 0, 0.26);
  color: #000000da;
}
</style>
