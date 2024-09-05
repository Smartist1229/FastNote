<template>
  <div class="classBox">
    <!-- 头部默认分类 -->
    <span>默认分组</span>
    <div class="Header">
      <div class="defaultClass">
        <div
          :class="allClassActive ? 'item activeClass' : 'item'"
          @click="getAllClassNote()"
        >
          <span class="iconfont">&#xe60a;</span>
          <span>所有分组</span>
        </div>
        <div
          :class="noClassActive ? 'item activeClass' : 'item'"
          @click="getNoteNoClass"
        >
          <span class="iconfont">&#xe60a;</span>
          <span>未分组</span>
        </div>
      </div>
    </div>
    <!-- 列表详细分类 -->
    <span>自定义分组</span>
    <div class="classList" ref="classListElectron">
      <div
        v-show="AllClass.length > 0"
        v-for="item in AllClass"
        :class="item.isActive ? 'item active' : 'item'"
        :key="item.id"
        @click.stop="changeIsActive(item)"
        @dblclick.stop="changClass"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop($event, item)"
      >
        <span class="iconfont">&#xec17;</span>
        <span v-if="!item.isEdit">{{ item.className }}</span>
        <input
          v-else
          v-myfocus="true"
          type="text"
          class="editClassName"
          placeholder="请输入分类名称"
          v-model="item.className"
          @blur="saveClass(item)"
          @keyup.enter="saveClass(item)"
        />
      </div>

      <div class="noList" v-show="AllClass.length <= 0">
        <span>暂无分类</span>
      </div>
    </div>

    <!-- 底部工具 -->
    <div class="tools">
      <div class="newClass" title="新建分组" @click="addClass">
        <span class="iconfont">&#xe637;</span>
      </div>
      <div class="rename" title="重命名分组" @click="changClass">
        <span class="iconfont">&#xe821;</span>
      </div>
      <div
        class="delete"
        title="删除分组：会将该分组下所有的笔记一起删除"
        @click="deleteClass"
      >
        <span class="iconfont">&#xe626;</span>
      </div>
      <div class="reload" title="刷新页面（全部重新加载）" @click="reloadPage">
        <span class="iconfont">&#xec08;</span>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
export default {
  name: "classBox",
};
</script>

<script lang="ts" setup>
import { ref, onMounted, nextTick } from "vue";
import { nanoid } from "nanoid";
import { toast } from "vue3-toastify";
import emitter from "../../utils/emitter";
import { executeSql, getResponse } from "../../hooks/useExecuteSql";
import { classInter } from "../../interface/classInter";
import { refresh } from "../../hooks/useRefresh";

// toast设置
import toastOption from "../../config/toastOption";

// 初始化数据
const AllClass = ref<classInter[]>([]);
const activeId = ref<string>("");
const activeName = ref<string>("");
// 点击处理css
const allClassActive = ref<boolean>(true);
const noClassActive = ref<boolean>(false);
// 被拖动的noteId
const dragNoteId = ref<string>("");
// 全部分类的列表
const classListElectron = ref<HTMLDivElement>();

// 获取新表并刷新页面
const getAllClass = async () => {
  executeSql(
    "execute-sql",
    "SELECT * FROM class",
    "findAll",
    "sql-result-class"
  );
  const response = await getResponse("sql-result-class");
  if (response.success) {
    response.result.forEach((element: classInter) => {
      element.isActive = false;
      element.isEdit = false;
    });
    AllClass.value = response.result;
  } else {
    // console.error("执行 SQL 失败:", response.error);
    toast.error(response.error, toastOption);
  }
};

// 当组件挂载时获取全部的分类数据
onMounted(() => {
  getAllClass();
});

// 新增类别
const addClass = () => {
  allClassActive.value = false;
  noClassActive.value = false;
  const newClass = {
    id: nanoid(),
    className: "",
    isEdit: true,
    isActive: true,
  };
  clearActive(); // 取消其他项目的激活状态
  AllClass.value.push(newClass);

  // 滚动到最底部
  nextTick(() => {
    if (classListElectron.value) {
      classListElectron.value.scrollTop = classListElectron.value.scrollHeight;
    }
  });
  // 清空itemList的id和name
  activeId.value = "";
  activeName.value = "";
  emitter.emit("classList-id", ""); // 清空itemList的id
  // 清空editContentBox组件的id
  emitter.emit("NodeList-id", "");
};

// 保存类别
const saveClass = (item: classInter) => {
  allClassActive.value = false;
  noClassActive.value = false;
  if (item.isEdit) {
    item.className = item.className.trim() || "未命名分组";
    const foundItem = AllClass.value.find((i) => i.id === item.id);
    // console.log(foundItem);

    if (foundItem) {
      let sql =
        foundItem.id === activeId.value
          ? "UPDATE class SET className = ? WHERE id = ?"
          : "INSERT INTO class (id, className) VALUES (?, ?)";
      let type = foundItem.id === activeId.value ? "update" : "insert";
      let params =
        foundItem.id === activeId.value
          ? [item.className, item.id]
          : [item.id, item.className];

      // 判断新增的item.id是不是当前选中的item.id，是就更新不是就新建
      executeSql("execute-sql", sql, type, "sql-result-class", params);
    }
    item.isEdit = false;
    // 清空itemList的id
    activeId.value = item.id;
    activeName.value = item.className;
    emitter.emit("classList-id", item.id);
    // 清空editContentBox组件的id
    emitter.emit("NodeList-id", "");
    // 将新的class信息交给edit
    emitter.emit("addClass", { className: item.className, classId: item.id });
  }
};

// 修改isActive => classitem被选中
const changeIsActive = (item: classInter) => {
  allClassActive.value = false;
  noClassActive.value = false;
  clearActive(); // 取消其他项目的选中状态
  item.isActive = true;
  activeId.value = item.id;
  activeName.value = item.className;
  emitter.emit("classList-id", activeId.value);
  // 清空editContentBox组件的id
  emitter.emit("NodeList-id", "");
  emitter.emit("classify", { noteId: "", classId: item.id });
};

// 修改class
const changClass = () => {
  AllClass.value.forEach((item: classInter) => {
    if (item.id === activeId.value) {
      item.isEdit = true;
      changeIsActive(item);
    }
  });
};

// 删除class
const deleteClass = () => {
  allClassActive.value = true;
  noClassActive.value = false;
  const itemToDelete = AllClass.value.find(
    (item) => item.id === activeId.value
  );

  if (itemToDelete) {
    executeSql(
      "execute-sql",
      "DELETE FROM class WHERE id = ?",
      "del",
      "sql-result-class",
      [activeId.value]
    );

    // 删除成功后将该分组下额所有笔记都删除
    executeSql(
      "execute-sql",
      "DELETE FROM notes WHERE classId = ?",
      "del",
      "sql-result-notes",
      [activeId.value]
    );
    // 删除后将editContentBox组件的id设置为空
    emitter.emit("NodeList-id", "");

    // 刷新页面
    AllClass.value = AllClass.value.filter(
      (item) => item.id !== activeId.value
    );

    // 删除类别后将删除的id传递给editContentBox组件
    emitter.emit("deleteClass", { className: "", classId: activeId.value });

    // 清空itemList的id与name
    activeId.value = "";
    activeName.value = "";
    emitter.emit("classList-id", "");
  }
};

// 所有分组
const getAllClassNote = () => {
  allClassActive.value = true;
  noClassActive.value = false;
  activeId.value = "";
  activeName.value = "";
  emitter.emit("classList-id", "");
  clearActive(); // 取消其他项目的选中状态
  emitter.emit("NodeList-id", "");
  emitter.emit("classify", { noteId: "", classId: "" });
};

// 未分组
const getNoteNoClass = () => {
  allClassActive.value = false;
  noClassActive.value = true;
  emitter.emit("classList-id", "noClass");
  clearActive(); // 取消其他项目的激活状态
  // 清空editContentBox组件的id
  emitter.emit("NodeList-id", "");
  emitter.emit("classify", { noteId: "", classId: "noClass" });
};

//监视来自editContentBox的classId
emitter.on("classify", (value: any) => {
  // 清空其他项目的选中
  clearActive();
  allClassActive.value = false;
  noClassActive.value = false;

  // 选中传过来的id对应的class
  if (value.classId !== "noClass") {
    if (value.classId === "") {
      allClassActive.value = true;
      emitter.emit("classList-id", "");
    } else {
      AllClass.value.forEach((item) => {
        if (item.id === value.classId) {
          item.isActive = true;
        }
      });
      emitter.emit("classList-id", value.classId);
    }
  } else {
    noClassActive.value = true;
    emitter.emit("classList-id", "noClass");
  }
});

// 取消其他项目的选中状态
const clearActive = () => {
  AllClass.value.forEach((item) => (item.isActive = false)); // 取消其他项目的激活状态
};

// 重载页面
const reloadPage = () => {
  refresh();
};

// item移入事件
const onDragOver = (event: DragEvent) => {
  event.preventDefault(); // 取消默认事件
  event!.dataTransfer!.dropEffect = "move";
  const el = event.currentTarget as HTMLElement;
  el.classList.add("draging");
};

// item移出事件
const onDragLeave = (event: DragEvent) => {
  const el = event.currentTarget as HTMLElement;
  el.classList.remove("draging");
};

// 获取拖动的Note的Id
emitter.on("dragNoteId", (Note: any) => {
  dragNoteId.value = Note.id;
});

// item移入后松开鼠标（放下元素）
const onDrop = (event: DragEvent, item: any) => {
  const el = event.currentTarget as HTMLElement;
  el.classList.remove("draging");
  // 修改笔记的分组数据
  // console.log(dragNoteId.value);

  executeSql(
    "execute-sql",
    "UPDATE notes SET classId = ? WHERE id = ?",
    "update",
    "ipdateNote",
    [item.id, dragNoteId.value]
  );
  // 修改完成后取消选中
  clearActive();
  allClassActive.value = false;
  noClassActive.value = false;
  // 选中修改分组后的class
  AllClass.value.forEach((classInfo) => {
    if (classInfo.id === item.id) {
      classInfo.isActive = true;
      activeId.value = classInfo.id;
    }
  });
  emitter.emit("classList-id", activeId.value);
};
</script>

<style scoped>
.classBox {
  width: 179px;
  height: 100vh;
  display: flex;
  flex-direction: column;
  border-right: #b1b1b173 1px solid;
  background-color: #f1f5f9;
}
/* 总样式 */
.Header,
.classList,
.tools {
  padding: 5px;
  box-sizing: border-box;
  width: 100%;
}
span {
  user-select: none;
}
/* 头部样式 */
.Header {
  height: 60px;
  border-bottom: #b1b1b173 1px solid;
}
.classBox > span {
  font-size: 13px;
  font-weight: bolder;
  color: #505050;
  margin-top: 5px;
  margin-left: 5px;
}
/* 列表样式 */
.classList {
  width: 100%;
  flex: 1;
  overflow-y: overlay;
  box-sizing: border-box;
}
/* 用于选择类名为 .classList 的元素的滚动条 */
.classList::-webkit-scrollbar {
  border-radius: 10px;
  width: 2px;
}
.classList:hover::-webkit-scrollbar {
  width: 4px;
}
/* 滚动条滑块 */
.classList::-webkit-scrollbar-thumb {
  border-radius: 10px;
  background-color: rgba(112, 112, 112, 0.322);
}
/* 工具样式 */
.tools {
  height: 30px;
  border-top: #b1b1b173 1px solid;
  display: flex;
  justify-content: space-around;
  align-items: center;
}
.tools div {
  height: 25px;
  width: 25px;
  text-align: center;
  line-height: 25px;
}
.tools div span {
  font-size: 14px;
}
/* 分类项目样式 */
.Header .item {
  margin-top: 3px;
  height: 20px;
  line-height: 20px;
}
.item {
  height: 25px;
  font-size: 12px;
  display: flex;
  align-items: center;
  margin-top: 3px;
  padding-left: 5px;
  width: 165px;
  padding-right: 5px;
  box-sizing: border-box;
}
.item span {
  margin-right: 6px;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.item span:first-child {
  font-size: 15px;
  margin-right: 10px;
  width: 25px;
}
.item span:nth-child(2) {
  width: 85%;
  text-align: left;
}
.item,
.newClass {
  border-radius: 5px;
}
.item:hover,
.tools div:hover {
  background-color: #e5e7eb;
}

.item input {
  width: 110px;
  border: none;
  background: rgb(0, 0, 0, 0);
  font-size: 12px;
}
.item input:focus {
  outline: none;
}

/* 暂无分类 */
.noList {
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  font-size: 13px;
  color: #9e9e9e;
}
</style>
