<template>
  <div class="itemListBox">
    <!-- 头部 -->
    <div class="Header">
      <input
        type="text"
        class="searchInput"
        placeholder="搜索"
        v-model="searchContent"
      />
      <div class="addItem" title="新建笔记" @click="addNote">
        <span class="iconfont">&#xe63a;</span>
      </div>
      <div class="delItem" title="删除笔记" @click="delNote">
        <span class="iconfont">&#xe626;</span>
      </div>
    </div>

    <div class="List">
      <!-- 列表详细分类 -->
      <span>所有笔记</span>
      <div class="itemList">
        <div
          v-if="AllNotes.length > 0"
          :class="item.isActive ? 'item active' : 'item'"
          v-for="item in AllNotes"
          :key="item.id"
          @click.stop="clickHandler(item)"
          @dblclick.stop="dblClickHandler(item)"
        >
          <div class="Title">
            <span v-if="!item.isEdit">{{ item.title }}</span>
            <input
              v-else
              type="text"
              placeholder="请输入笔记名"
              v-myfocus="true"
              v-model="item.title"
              @blur="saveNote(item)"
              @keyup.enter="saveNote(item)"
            />
          </div>
          <span>{{ item.date }}</span>
        </div>

        <div class="noList" v-else>
          <span>暂无笔记</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
export default {
  name: "itemListBox",
};
</script>

<script lang="ts" setup>
import { onMounted, ref, watch, nextTick, onBeforeUpdate } from "vue";
import { nanoid } from "nanoid";
import moment from "moment";
import mitter from "../../utils/mitter";
import { executeSql, getResponse } from "../../hooks/useExecuteSql";

// 初始化数据
let AllNotes = ref([]);
let activeId = ref<string>("");
let searchContent = ref<string>("");
let classId = ref<string>("");

let clickTimer: NodeJS.Timeout | null = null;

// 获取全部笔记
const getAllNotes = async () => {
  const responseEvent = "sql-result-notes";
  executeSql("execute-sql", "SELECT * FROM notes", "findAll", responseEvent);

  const response = await getResponse(responseEvent);
  if (response.success) {
    response.result.forEach((element) => {
      element.isActive = false;
      element.isEdit = false;
    });
    AllNotes.value = response.result;
  } else {
    console.error("执行 SQL 失败:", response.error);
  }
};

// 当组件挂载时获取全部的分类数据
onMounted(() => {
  getAllNotes();
});

// 数据更新前
onBeforeUpdate(() => {
  const targetNote = AllNotes.value.find((item) => item.id === activeId.value);
  if (targetNote) {
    targetNote.isActive = true;
  }
});

// 组件选中
const changeIsActive = (item: any) => {
  // 取消选中
  clearActive();
  item.isActive = true;
  activeId.value = item.id;
  // 传递笔记id
  mitter.emit("NodeList-id", item.id);
  // 传递分类id
  mitter.emit("classIdtoEdit", item.classId);
  mitter.emit("classify", {
    noteId: item.id,
    classId: item.classId || "noClass",
  });
};

// 单击处理函数
const clickHandler = (item: any) => {
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
  }
  clickTimer = setTimeout(() => {
    changeIsActive(item);
  }, 100);
};

// 双击处理函数
const dblClickHandler = (item: any) => {
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
  }
  changeNote();
};

// 搜索功能实现
watch(searchContent, (newValue) => {
  const responseEvent = "sql-result-notes-search";
  let sql = classId.value
    ? `SELECT * FROM notes WHERE classId = '${classId.value}' AND title LIKE '%${newValue}%'`
    : `SELECT * FROM notes WHERE title LIKE '%${newValue}%'`;
  if (classId.value === "noClass")
    sql = `SELECT * FROM notes WHERE classId = '' AND title LIKE '%${newValue}%'`;
  executeSql("execute-sql", sql, "findAll", responseEvent);

  getResponse(responseEvent)
    .then((noteList) => {
      noteList.result.forEach((element) => {
        element.isActive = false;
      });
      AllNotes.value = noteList.result;
    })
    .catch((error) => {
      console.error("执行 SQL 失败:", error);
    });
});

// 新增笔记
const addNote = () => {
  clearActive(); // 取消其他项目的激活状态
  const newNote = {
    id: nanoid(),
    title: "",
    date: "" + moment(new Date()).format("YYYY/MM/DD"),
    content: "",
    classId: classId.value && classId.value != "noClass" ? classId.value : "",
    isActive: true,
    isEdit: true,
  };  
  AllNotes.value.push(newNote);

  // 滚动到最底部
  nextTick(() => {
    const classList = document.querySelector(".classList");
    if (classList) {
      classList.scrollTop = classList.scrollHeight;
    }
  });
};

// 保存笔记
const saveNote = (item: any) => {
  clearActive();
  if (item.isEdit) {
    item.title = item.title.trim() || "未命名笔记";
    const foundItem = AllNotes.value.find((i) => i.id === item.id);

    if (foundItem) {
      let sql =
        foundItem.id === activeId.value
          ? `UPDATE notes SET title = ? WHERE id = ?`
          : `INSERT INTO notes (id, title, date, content, classId) VALUES (?, ?, ?, ?, ?)`;
      let params =
        foundItem.id === activeId.value
          ? [item.title, item.id]
          : [item.id, item.title, item.date, item.content, item.classId];
      let type = foundItem.id === activeId.value ? "update" : "insert";
      executeSql("execute-sql", sql, type, "sql-result-notes", params);

      if (type === "update") {
        mitter.emit('update-content',{id: item.id,title: item.title,content: item.content})
      }
    }
  }
  item.isEdit = false;
  activeId.value = item.id;
  searchContent.value = "";
  // 将新增的item的id传送给editContentBox组件
  mitter.emit("NodeList-id", item.id);
  mitter.emit("classIdtoEdit", item.classId);
};

// 修改笔记
const changeNote = () => {
  AllNotes.value.forEach((item) => {
    if (item.id === activeId.value) {
      item.isEdit = true;
    }
  });
};

// 删除笔记
const delNote = () => {
  const itemToDelete = AllNotes.value.find(
    (item) => item.id === activeId.value
  );
  if (itemToDelete) {
    executeSql(
      "execute-sql",
      "DELETE FROM notes WHERE id = ?",
      "del",
      "sql-result-notes",
      [activeId.value]
    );
    // 删除后将editContentBox组件的id设置为空
    mitter.emit("NodeList-id", "");
  }
  // 刷新页面
  AllNotes.value = AllNotes.value.filter((item) => item.id !== activeId.value);
  // 删除后将选中的id清空
  activeId.value = "";
};

// 当标题或内容被editContentBox组件修改时
mitter.on("update-content", (value: any) => {
  executeSql(
    "execute-sql",
    "UPDATE notes SET title = ?, content = ? WHERE id = ?",
    "update",
    "ipdateNote",
    [value.title.trim() || "未命名笔记", value.content, value.id]
  );
  AllNotes.value.forEach((item: any) => {
    if (item.id === value.id) {
      item.title = value.title.trim() || "未命名笔记";
      item.content = value.content; // 更新 content
    }
  });
});

//监视来自editContentBox的noteId
mitter.on("classify", (value: any) => {

  clearActive(); // 取消全部选中
  activeId.value = value.noteId;
  // 如果calssId是noClass
  let classId = value.classId === "noClass" ? "" : value.classId;
  AllNotes.value.forEach((item) => {
    if (item.id === value.noteId) {
      executeSql(
        "execute-sql",
        "UPDATE notes SET classId = ? WHERE id = ?",
        "update",
        "sql-result-notes",
        [classId, value.noteId]
      );
    }
  });
  // activeId.value = value.noteId;
});

// 获取点击的分类id
let changeNoteListTimer:any;
mitter.on("classList-id", (id: any) => {
  clearTimeout(changeNoteListTimer);
  changeNoteListTimer = setTimeout(() => {
    
    // 取消去他item的选中
    clearActive();
    // 设置sql语句
    classId.value = id || "";
    let sql = id
      ? `SELECT * FROM notes WHERE classId = '${id}'`
      : "SELECT * FROM notes";
    if (id === "noClass") {
      classId.value = "noClass";
      sql = "SELECT * FROM notes WHERE classId = ''";
    }
    // 发送请求获取数据
    executeSql("execute-sql", sql, "findAll", "classActive");
    // 给每一项添加两个属性
    getResponse("classActive")
      .then((noteList) => {
        noteList.result.forEach((element) => {
          element.isActive = false;
          element.isEdit = false;
        });
        AllNotes.value = noteList.result;
      })
      .catch((error) => {
        console.error("执行 SQL 失败:", error);
      });
    searchContent.value = "";
  });
});

// 取消其他note的选中状态
const clearActive = () => {
  AllNotes.value.forEach((item) => {
    item.isActive = false;
  });
};
</script>

<style scoped>
.itemListBox {
  width: 199px;
  height: 100vh;
  background-color: rgb(255, 255, 255);
  border-right: #b1b1b173 1px solid;
  padding: 3px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
}
.itemListBox > div > span {
  font-size: 13px;
  font-weight: bolder;
  color: #505050;
  margin-top: 5px;
  margin-left: 5px;
}
span {
  user-select: none;
}
/* 头部区域 */
.Header {
  width: 100%;
  height: 30px;
  border-bottom: 1px solid #b1b1b173;
  display: flex;
  align-items: center;
}
.Header .searchInput {
  width: 150px;
  border: none;
  background-color: #ffffff;
  padding: 5px;
  box-sizing: border-box;
  border-radius: 5px;
  font-size: 13px;
  font-weight: bolder;
  color: #666666;
  user-select: none;
}
.searchInput:focus {
  outline: none;
}
.Header div {
  height: 20px;
  width: 20px;
  cursor: pointer;
  border-radius: 5px;
  line-height: 20px;
  text-align: center;
}
.Header div:hover {
  background-color: #7a7a7a67;
}
.Header div span {
  font-size: 20px;
  text-align: center;
  line-height: 20px;
}
.Header div:last-child span {
  font-size: 16px;
  line-height: 16px;
}

/* 列表样式 */
.List {
  box-sizing: border-box;
}
.itemList {
  width: 100%;
  height: calc(100vh - 53px);
  overflow-y: overlay;
  overflow-x: hidden;
  padding-right: 5px;
  box-sizing: border-box;
}
/* 用于选择类名为 .classList 的元素的滚动条 */
.itemList::-webkit-scrollbar {
  border-radius: 10px;
  width: 2px;
}
.itemList:hover::-webkit-scrollbar {
  width: 4px;
}
/* 滚动条滑块 */
.itemList::-webkit-scrollbar-thumb {
  border-radius: 10px;
  background-color: rgba(112, 112, 112, 0.322);
}

/* 分类项目样式 */
.item {
  height: 25px;
  font-size: 11px;
  display: flex;
  align-items: center;
  margin-top: 3px;
  padding-left: 5px;
  width: 185px;
  padding-right: 5px;
  box-sizing: border-box;
  justify-content: space-between;
  cursor: pointer;
}
.item .Title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  box-sizing: border-box;
}
.item .Title span {
  font-weight: bolder;
  color: #000000da;
}
.item .Title input {
  width: 90%;
  background: rgba(0, 0, 0, 0);
  border: none;
  font-size: 11px;
  font-weight: bolder;
}
.item .Title input:focus {
  outline: none;
}
.item > span {
  font-size: 10px;
  margin-left: 5px;
}
.item,
.newClass {
  border-radius: 5px;
}
.item:hover,
.newClass:hover {
  background-color: #7a7a7a33;
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
