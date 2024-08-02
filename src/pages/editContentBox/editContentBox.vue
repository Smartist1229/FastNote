<template>
  <div class="editContentBox">
    <div v-if="NoteId">
      <div class="Title">
        <input
          type="text"
          class="titleInput"
          placeholder="在此编辑标题"
          v-model="title"
          @blur="nullDefaultTitle"
        />
      </div>

      <div class="tools">
        <div class="textLength">字数：{{ contentLength }}</div>
      </div>

      <div class="Edit">
        <textarea
          placeholder="在此编辑文档内容"
          v-model="content"
          spellcheck="false"
          v-myfocus="true"
        ></textarea>
      </div>
    </div>

    <div v-else class="noId">
      <span class="iconfont">&#xe615;</span>
      <span>您还没有选择笔记</span>
    </div>
  </div>
</template>

<script lang="ts">
export default {
  name: "editContentBox",
};
</script>

<script lang="ts" setup>
import { ref, watch } from "vue";
import { executeSql, getResponse } from "../../hooks/useExecuteSql";
const { ipcRenderer } = window.electron;

// 初始化数据
let NoteId = ref("");
let title = ref("");
let content = ref("");
let contentLength = ref(0);

// 获取点击的笔记id
ipcRenderer.on("NodeList-id", (event, response) => {
  if (response.success) {
    NoteId.value = response.id;
    if (response.id) {
      const responseEvent = "sql-result-note";
      executeSql(
        "execute-sql",
        `SELECT * FROM notes WHERE id = '${response.id}'`,
        "findOne",
        responseEvent
      );
      getResponse(responseEvent)
        .then((note) => {
          if (note.success) {
            // console.log("获取笔记成功", note);

            content.value = note.result.content;
            title.value = note.result.title;
          }
        })
        .catch((error) => {
          console.error("执行 SQL 失败:", error);
        });
    } else {
      content.value = "";
      title.value = "";
    }
  }
});

// 监听标题和内容变化并通知itemListBox更新
watch([title, content], () => {
  if (NoteId.value) {
    ipcRenderer.send("update-content", {
      id: NoteId.value,
      title: title.value,
      content: content.value,
    });
    contentLength.value = content.value.length;
  }
});

// 当标题为空并且失去焦点时，将标题设置为默认值
function nullDefaultTitle() {
  if (title.value === "") {
    title.value = "未命名笔记";
  }
}
</script>

<style scoped>
.editContentBox {
  width: calc(100vw - 380px);
  height: 100%;
  background-color: #ffffff;
  display: flex;
  flex-direction: column;
}
span {
  user-select: none;
}

/* 标题区 */
.Title {
  width: 100%;
  height: 49px;
}
.Title input {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  border: none;
  font-weight: bolder;
  padding: 0 10px;
  font-size: 20px;
  text-align: center;
}
.Title input:focus {
  outline: none;
}

/* 工具区 */
.tools {
  width: 100%;
  height: 28px;
  border-bottom: 1px solid #e2e2e2;
  border-top: 1px solid #e2e2e2;
  background-color: #ffffff;
  font-size: 12px;
  color: #00000070;
  font-weight: bolder;
}
.tools .textLength {
  height: 100%;
  width: 99px;
  line-height: 28px;
  text-align: center;
  border-right: 1px solid #e2e2e2;
}

/* 编辑区 */
.Edit {
  width: 100%;
  height: calc(100vh - 83px);
  background-color: rgb(255, 255, 255);
  padding-right: 2px;
  box-sizing: border-box;
  display: flex;
  justify-content: center;
  align-items: center;
}
.Edit textarea {
  display: block;
  width: 100%;
  height: 100%;
  padding: 10px;
  padding-right: 20px;
  box-sizing: border-box;
  overflow-y: overlay;
  overflow-x: hidden;
  resize: none;
  border: none;
}
.Edit textarea:focus {
  outline: none;
}
/* 用于选择类名为 .classList 的元素的滚动条 */
textarea::-webkit-scrollbar {
  box-sizing: border-box;
  border-radius: 10px;
  width: 2px;
}
textarea:hover::-webkit-scrollbar {
  box-sizing: border-box;
  width: 4px;
}
/* 滚动条滑块 */
textarea::-webkit-scrollbar-thumb {
  border-radius: 10px;
  background-color: rgba(112, 112, 112, 0.322);
}

/* 没有文章 */
.noId {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  font-size: 20px;
  color: #c2c2c2;
  box-sizing: border-box;
}
.noId .iconfont {
  font-size: 50px;
}
.noId span:last-child {
  margin-top: 20px;
}
</style>
