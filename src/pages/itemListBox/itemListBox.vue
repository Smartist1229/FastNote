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
          @click="changeIsActive(item)"
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
              @click.stop
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
import { onMounted, ref, watch, nextTick } from "vue";
import { nanoid } from "nanoid";
import moment from "moment";
const { ipcRenderer } = window.electron;

// 初始化数据
let AllNotes = ref([]);
let activeId = ref("");
let searchContent = ref("");
let classId = ref("");

// 获取点击的分类id
ipcRenderer.on("classList-id", (event, response) => {
  if (response.success) {
    if (response.id) {
      if (response.id === "noClass") {
        classId.value = response.id;
        ipcRenderer.send("execute-sql", {
          sql: `SELECT * FROM notes WHERE classId = ''`,
          type: "findAll",
          responseEvent: "classActive",
        });
        ipcRenderer.on("classActive", (event, response) => {
          if (response.success) {
            response.result.forEach((element) => {
              element.isActive = false;
              element.isEdit = false;
            });
            AllNotes.value = response.result;
          } else {
            console.error("执行 SQL 失败:", response.error);
          }
        });
      } else {
        classId.value = response.id;
        ipcRenderer.send("execute-sql", {
          sql: `SELECT * FROM notes WHERE classId = '${response.id}'`,
          type: "findAll",
          responseEvent: "classActive",
        });
        ipcRenderer.on("classActive", (event, response) => {
          if (response.success) {
            response.result.forEach((element) => {
              element.isActive = false;
              element.isEdit = false;
            });
            AllNotes.value = response.result;
          } else {
            console.error("执行 SQL 失败:", response.error);
          }
        });
      }
    } else {
      classId.value = response.id;
      ipcRenderer.send("execute-sql", {
        sql: `SELECT * FROM notes`,
        type: "findAll",
        responseEvent: "classActive",
      });
      ipcRenderer.on("classActive", (event, response) => {
        if (response.success) {
          response.result.forEach((element) => {
            element.isActive = false;
            element.isEdit = false;
          });
          AllNotes.value = response.result;
        } else {
          console.error("执行 SQL 失败:", response.error);
        }
      });
    }
    searchContent.value = "";
  }
});

const getAllNotes = () => {
  const responseEvent = "sql-result-notes";
  if (classId.value) {
    if (classId.value === "noClass") {
      ipcRenderer.send("execute-sql", {
        sql: `SELECT * FROM notes WHERE classId = ''`,
        type: "findAll",
        responseEvent,
      });
    } else {
      ipcRenderer.send("execute-sql", {
        sql: `SELECT * FROM notes WHERE classId = '${classId.value}'`,
        type: "findAll",
        responseEvent,
      });
    }
  } else {
    ipcRenderer.send("execute-sql", {
      sql: "SELECT * FROM notes",
      type: "findAll",
      responseEvent,
    });
  }

  ipcRenderer.on(responseEvent, (event, response) => {
    if (response.success) {
      response.result.forEach((element) => {
        element.isActive = false;
        element.isEdit = false;
      });
      AllNotes.value = response.result;
    } else {
      console.error("执行 SQL 失败:", response.error);
    }
  });
};

// 当组件挂载时获取全部的分类数据
onMounted(() => {
  getAllNotes();
});

// 组件选中
const changeIsActive = (item: any) => {
  AllNotes.value.forEach((element: any) => {
    element.isActive = false;
  });
  item.isActive = true;
  activeId.value = item.id;
  ipcRenderer.send("get-id", {
    id: item.id,
    responseEvent: "NodeList-id",
  });
};

// 搜索功能实现
watch(searchContent, (newValue) => {
  const responseEvent = "sql-result-notes-search";
  if (classId.value) {
    if (classId.value === "noClass") {
      ipcRenderer.send("execute-sql", {
        sql: `SELECT * FROM notes WHERE classId = '' AND title LIKE '%${newValue}%'`,
        type: "findAll",
        responseEvent,
      });
    } else {
      ipcRenderer.send("execute-sql", {
        sql: `SELECT * FROM notes WHERE classId = '${classId.value}' AND title LIKE '%${newValue}%'`,
        type: "findAll",
        responseEvent,
      });
    }
  } else {
    ipcRenderer.send("execute-sql", {
      sql: `SELECT * FROM notes WHERE title LIKE '%${newValue}%'`,
      type: "findAll",
      responseEvent,
    });
  }

  ipcRenderer.on(responseEvent, (event, response) => {
    if (response.success) {
      response.result.forEach((element) => {
        element.isActive = false;
      });
      AllNotes.value = response.result;
    } else {
      console.error("执行 SQL 失败:", response.error);
    }
  });
});

// 新增笔记
const addNote = () => {
  const newNote = {
    id: nanoid(),
    title: "",
    date: "" + moment(new Date()).format("YYYY/MM/DD"),
    content: "",
    classId: classId.value && classId.value != "noClass" ? classId.value : "",
    isActive: true,
    isEdit: true,
  };
  AllNotes.value.forEach((item) => (item.isActive = false)); // 取消其他项目激活状态
  AllNotes.value.push(newNote);

  // 滚动到最底部
  nextTick(() => {
    const classList = document.querySelector(".classList");
    if (classList) {
      classList.scrollTop = classList.scrollHeight;
    }
  });
  // 暂时的解决方案，还没想好怎么写(添加后将editContentBox组件的id设置为空)
  deleteEditContent();
};

// 保存笔记
const saveNote = (item: any) => {
  if (item.isEdit) {
    item.title = item.title.trim() || "未命名笔记";
    // 插入新分类
    ipcRenderer.send("execute-sql", {
      sql: `INSERT INTO notes VALUES ('${item.id}','${item.title}','${item.date}','${item.content}','${item.classId}')`,
      type: "insert",
      responseEvent: "sql-result-notes",
    });
  }
  item.isEdit = false;
  activeId.value = "";
  searchContent.value = "";
  getAllNotes();
};

// 删除笔记
const delNote = () => {
  const itemToDelete = AllNotes.value.find(
    (item) => item.id === activeId.value
  );
  if (itemToDelete) {
    ipcRenderer.send("execute-sql", {
      sql: "DELETE FROM notes WHERE id = ?",
      type: "del",
      params: [activeId.value],
      responseEvent: "sql-result-notes",
    });
    // 删除后将editContentBox组件的id设置为空
    deleteEditContent();
  }
  getAllNotes();
};

// 当标题或内容被editContentBox组件修改时
ipcRenderer.on("update-content", (event, response) => {
  if (response.success) {
    // 更新现有分类
    ipcRenderer.send("execute-sql", {
      sql: "UPDATE notes SET title = ?,content = ? WHERE id = ?",
      type: "update",
      params: [response.title, response.content, response.id],
      responseEvent: "ipdateNote",
    });
    getAllNotes();
  }
});

// 将editContentBox组件的id设置为空
const deleteEditContent = () => {
  ipcRenderer.send("get-id", {
    id: "",
    responseEvent: "NodeList-id",
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
  overflow-y: scroll;
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
