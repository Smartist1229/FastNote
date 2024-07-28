<template>
  <div class="editContentBox">
    <div v-if="NoteId">
      <div class="Title">
        <input type="text" class="titleInput" placeholder="标题" v-model="title"/>
      </div>
      <div class="Edit">
        <textarea placeholder="文档内容" v-model="content" v-myfocus="true" spellcheck="false"></textarea>
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
import { reactive, ref, watch } from "vue";
const { ipcRenderer } = window.electron;

// 初始化数据
let NoteData = reactive([]);
let NoteId = ref('');
let title = ref('');
let content = ref('');

ipcRenderer.on('NodeList-id',(event,response) => {
  if(response.success){
    NoteId.value = response.id;
    
    const responseEvent = "sql-get-note-data";
    ipcRenderer.send("execute-sql", {
      sql: `SELECT * FROM notes WHERE id = ?`,
      params: [response.id],
      type: "findAll",
      responseEvent,
    });
    ipcRenderer.on(responseEvent, (event, response) => {
      if (response.success) {
        NoteData = response.result;
        title.value = NoteData[0].title;
        content.value = NoteData[0].content;
      } else {
        console.error("执行 SQL 失败:", response.error);
      }
    });
  }
  
})

// 修改内容
watch(title, (newValue) => {
  ipcRenderer.send('update-content',{
    id: NoteId.value,
    title: newValue,
    content: content.value
  })
})
watch(content, (newValue) => {
  ipcRenderer.send('update-content',{
    id: NoteId.value,
    title: title.value,
    content: newValue
  })
})
</script>

<style scoped>
.editContentBox {
  width: calc(100vw - 380px);
  height: auto;
  background-color: #ffffff;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
}
/* 标题区 */
.Title {
  width: 100%;
  height: 49px;
  border-bottom: 1px solid #c2c2c2;
  box-sizing: border-box;
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

/* 编辑区 */
.Edit textarea {
  resize: none;
}
.Edit textarea {
  width: 100%;
  height: calc(100vh - 54px);
  box-sizing: border-box;
  border: none;
  padding: 10px;
}
.Edit textarea:focus {
  outline: none;
}
/* 用于选择类名为 .classList 的元素的滚动条 */
textarea::-webkit-scrollbar {
  border-radius: 10px;
  width: 2px;
}
textarea:hover::-webkit-scrollbar {
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
