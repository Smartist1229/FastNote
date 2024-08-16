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
        <div class="classify" title="分类、设置分类">
          <select class="classList" v-model="selectId">
            <option value="noClass" :selected="noClass">未分组</option>
            <option
              v-for="classItem in classList"
              :value="classItem.id"
              :key="classItem.id"
              :selected="classItem.isActive"
            >
              {{ classItem.className }}
            </option>
          </select>
        </div>
        <div class="textLength" title="总字数：包括回车空格">字数：{{ contentLength }}</div>
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
import { ref, watch, onMounted } from "vue";
import { executeSql, getResponse } from "../../hooks/useExecuteSql";
import mitter from "../../utils/mitter";
const { ipcRenderer } = window.electron;

// 初始化数据
let NoteId = ref("");
let title = ref("");

let content = ref("");
let contentLength = ref(0);

let classList = ref([]);
let selectId = ref("");
let noClass = ref(false);

// 页面挂载时，更新分类列表
onMounted(() => {
  getClassList();
});

// 获取classList
const getClassList = async () => {
  executeSql("execute-sql", "SELECT * FROM class", "findAll", "editClassList");
  const response = await getResponse("sql-result-class");
  if (response.success) {
    response.result.forEach((element: any) => {
      element.isActive = false;
    });
    classList.value = response.result;
  } else {
    console.error("执行 SQL 失败:", response.error);
  }
};

// 获取用户点击的item对应的classId
mitter.on('classIdtoEdit',(id:any) => {
  classList.value.forEach((item) => (item.isActive = false)); // 取消其他项目的激活状态
  noClass.value = false;
    if (id !== "") {
      const classId = id;
      classList.value.forEach((element: any) => {
        if (element.id === classId) {
          element.isActive = true;
          selectId.value = classId;
        } else {
          element.isActive = false;
        }
      });
    } else {
      noClass.value = true;
      selectId.value = "noClass";
    }
})

// 获取点击的笔记id
mitter.on('NodeList-id',(id:any)=> {
  NoteId.value = id;
    if (id) {
      const responseEvent = "sql-result-note";
      executeSql(
        "execute-sql",
        `SELECT * FROM notes WHERE id = '${id}'`,
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
})

// 获取新建的class
mitter.on('addClass',(value:any) => {
  const classObj = {
    id: value.classId,
    className: value.className,
    isActive: false
  };
  // 查找并替换或添加 classObj
  const index = classList.value.findIndex(item => item.id === classObj.id);
  if (index !== -1) {
    // 如果找到了，则替换
    classList.value[index] = classObj;
  } else {
    // 如果没找到，则添加
    classList.value.push(classObj);
  }
})

// 删除一个class
mitter.on('deleteClass',(value:any) => {
  classList.value = classList.value.filter((item: any) => item.id !== value.classId);
})

// 监听selectId的变化
watch(selectId, (newValue) => {
  mitter.emit("classify", {noteId:NoteId.value, classId:newValue});
});

// 监听标题和内容变化并通知itemListBox更新
watch([title, content], () => {
  if (NoteId.value) {
    mitter.emit('update-content',{id:NoteId.value, title:title.value, content:content.value})
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
  display: flex;
}
.tools .textLength {
  height: 100%;
  width: 99px;
  line-height: 28px;
  text-align: center;
  border-right: 1px solid #e2e2e2;
  font-size: 12px;
}
.tools .classify {
  height: 100%;
  width: 99px;
  background-color: red;
  border-right: 1px solid #e2e2e2;
}
.classify .classList {
  width: 100%;
  height: 100%;
  border: none;
  outline: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
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
