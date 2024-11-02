<template>
  <div class="editContentBox">
    <div v-show="title">
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
        <div
          class="textLength"
          :title="`总字数：${contentLength}&#10;去除回车后字数：${contentLengthNoEnter}`"
        >
          字数：{{ contentLengthNoEnter }}
        </div>
        <div class="copyContent" title="复制内容" @click="copyContent">
          <span class="iconfont">&#xec7a;</span>
        </div>
        <div class="exportContent" title="将内容导出" @click="exportContent">
          <span class="iconfont">&#xe61c;</span>
        </div>
        <div
          class="switchEditor"
          title="切换编辑器，目前支持：&#10;MonacoEditor、MdEditor"
          @click="focusEditor"
        >
          <span class="iconfont">&#xe61f;</span>
        </div>
      </div>

      <div class="Edit">
        <MonacoEditor v-if="editorType"></MonacoEditor>
        <MdEditor
          v-if="!editorType"
          v-model="content"
          theme="light"
          style="height: 100%"
          :toolbarsExclude="MdEditorNotShowTools"
          :footers="MdEditorFooters"
          previewTheme="github"
          :preview="false"
        />
      </div>
    </div>

    <div v-show="!title" class="noId">
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
import { ref, watch, onMounted, nextTick } from "vue";
import { executeSql, getResponse } from "../../hooks/useExecuteSql";
import emitter from "../../utils/emitter";
import { toast } from "vue3-toastify";
import "vue3-toastify/dist/index.css";
import { classInter } from "../../interface/classInter";
import { MdEditor } from "md-editor-v3";
import "md-editor-v3/lib/style.css";
import {ToolbarTips, Footers} from "../../interface/MdEditor"
import MonacoEditor from "../MonacoEditor/MonacoEditor.vue";

// toast设置
import toastOption from "../../config/toastOption";

const { saveFile } = window.electron;

// 初始化数据
const NoteId = ref<string>("");
const title = ref<string>("");
const content = ref<string>("");
// 文本长度数据
const contentLength = ref<number>(0);
const contentLengthNoEnter = ref<number>(0);
// 分类选择数据
const classList = ref<classInter[]>([]);
const selectId = ref<string>("");
const noClass = ref<boolean>(false);
// 编辑器切换
const editorType = ref<boolean>(true);
// MdEditor工具栏不显示的工具 和 页脚
const MdEditorNotShowTools = ref<ToolbarTips[]>(["save", "github"]);
const MdEditorFooters = ref<Footers[]>([]);

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
    // console.error("执行 SQL 失败:", response.error);
    toast.error(response.error, toastOption);
  }
};

// 获取用户点击的item对应的classId
emitter.on("classIdtoEdit", (id: any) => {
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
});

// 获取点击的笔记id
emitter.on("NodeList-id", (id: any) => {
  // clearInterval(intervalId);   // 点击一个新的笔记结束定时器
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
          title.value = note.result.title;
          content.value = note.result.content;
          // 将内容传递给MonacoEditor组件
          nextTick(() => {
            emitter.emit("noteContent", note.result.content);
          });
        }
      })
      .catch((error) => {
        // console.error("执行 SQL 失败:", error);
        toast.error(error, toastOption);
      });
  } else {
    // 将内容传递给MonacoEditor组件
    emitter.emit("noteContent", "");
    title.value = "";
  }
});

// 获取新建的class
emitter.on("addClass", (value: any) => {
  const classObj = {
    id: value.classId,
    className: value.className,
    isActive: false,
  };
  // 查找并替换或添加 classObj
  const index = classList.value.findIndex((item) => item.id === classObj.id);
  if (index !== -1) {
    // 如果找到了，则替换
    classList.value[index] = classObj;
  } else {
    // 如果没找到，则添加
    classList.value.push(classObj);
  }
});

// 删除一个class
emitter.on("deleteClass", (value: any) => {
  classList.value = classList.value.filter(
    (item: any) => item.id !== value.classId
  );
});

// 监听selectId的变化
watch(selectId, (newValue) => {
  emitter.emit("classify", { noteId: NoteId.value, classId: newValue });
});

// 获取新的contet
emitter.on("contentChange", (value) => {
  content.value = value as string;
});

// 监听内容变化并通知itemListBox更新
watch([title, content], () => {
  if (NoteId.value) {
    emitter.emit("update-content", {
      id: NoteId.value,
      title: title.value,
      content: content.value,
    });
    contentLength.value = content.value.length;
    contentLengthNoEnter.value = content.value.replace(/\n/g, "").length;
  }
});

// 当标题为空并且失去焦点时，将标题设置为默认值
function nullDefaultTitle() {
  if (title.value === "") {
    title.value = "未命名笔记";
  }
}

// 复制按钮点击事件
const copyContent = async () => {
  try {
    if (content.value) {
      await navigator.clipboard.writeText(content.value);
      toast.success("复制成功", toastOption);
    } else {
      toast.info("内容为空", toastOption);
    }
  } catch (error) {
    toast.error(`复制失败:${error}`, toastOption);
  }
};

// 导出为txt
const exportContent = () => {
  saveFile(title.value, content.value).then((result) => {
    if (result.success) {
      toast.success(`导出成功，文件路径为：${result.filePath}`, toastOption);
    } else {
      // toast.error(`导出失败：${result.error}`, toastOption);
      console.log(result.error);
    }
  });
};

// 切换编辑器
const focusEditor = () => {
  editorType.value = !editorType.value;
  nextTick(() => {
    emitter.emit("newContent", content.value);
  });
};

// MdEditor编辑内容
// watch(content,() => {
//   emitter.emit("newContent", content.value);
// })
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
.tools div:hover {
  background-color: #e5e7eb;
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
.copyContent,
.exportContent,
.switchEditor {
  height: 100%;
  width: 28px;
  text-align: center;
  line-height: 28px;
  border-right: 1px solid #e2e2e2;
  cursor: pointer;
}
.copyContent span {
  font-size: 16px;
}
.switchEditor span {
  font-size: 12px;
}

.exportContent span {
  font-size: 18px;
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
