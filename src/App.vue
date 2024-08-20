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
  src: url("@/assets/font/aliIcon/iconfont.woff2?t=1722092595666") format("woff2"),
    url("@/assets/font/aliIcon/iconfont.woff?t=1722092595666") format("woff"),
    url("@/assets/font/aliIcon/iconfont.ttf?t=1722092595666") format("truetype");
}
@font-face {
  font-family: "pingfang";
  src: url("@/assets/font/macFont/pingfang.ttf")
}
* {
  margin: 0;
  padding: 0;
  font-family: "pingfang";
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
  background-color: #7a7a7a67 !important;
}
.activeClass {
  background-color: #fdcf0067 !important;
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

/* 移入时选中的样式 */
.draging {
  cursor: move;
  background-color: #00cafd3f !important;
}
</style>
