<template>
  <div class="classBox">
    <!-- 头部默认分类 -->
    <span>默认分组</span>
    <div class="Header">
      <div class="defaultClass">
        <div :class="allClassActive?'item activeClass':'item'" @click="getAllClassNote()">
          <span class="iconfont">&#xe60a;</span>
          <span>所有分组</span>
        </div>
        <div :class="noClassActive?'item activeClass':'item'" @click="getNoteNoClass">
          <span class="iconfont">&#xe60a;</span>
          <span>未分组</span>
        </div>
      </div>
    </div>
    <!-- 列表详细分类 -->
    <span>所有分组</span>
    <div class="classList">
      <div
        v-if="AllClass.length > 0"
        v-for="item in AllClass"
        :class="item.isActive ? 'item active' : 'item'"
        :key="item.id"
        @click="changeIsActive(item)"
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

      <div class="noList" v-else>
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
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, onMounted, nextTick } from "vue";
import { nanoid } from "nanoid";
const { ipcRenderer } = window.electron;

// 初始化数据
const AllClass = ref([]);
const activeId = ref("");
// 点击处理css
const allClassActive = ref(true);
const noClassActive = ref(false);

// 获取新表并刷新页面
const getAllClass = () => {
  const responseEvent = "sql-result-class";
  ipcRenderer.send("execute-sql", {
    sql: "SELECT * FROM class",
    type: "findAll",
    responseEvent,
  });

  ipcRenderer.on(responseEvent, (event, response) => {
    if (response.success) {
      response.result.forEach((element) => {
        element.isActive = false;
        element.isEdit = false;
      });
      AllClass.value = response.result;
    } else {
      console.error("执行 SQL 失败:", response.error);
    }
  });
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
  AllClass.value.forEach((item) => (item.isActive = false)); // 取消其他项目的激活状态
  AllClass.value.push(newClass);

  // 滚动到最底部
  nextTick(() => {
    const classList = document.querySelector(".classList");
    if (classList) {
      classList.scrollTop = classList.scrollHeight;
    }
  });
  // 清空itemList的id
  deleteItemList();

};

// 保存类别
const saveClass = (item: any) => {
  allClassActive.value = true;
  noClassActive.value = false;
  if (item.isEdit) {
    item.className = item.className.trim() || "未命名分组";
    const foundItem = AllClass.value.find((i) => i.id === item.id);
    if (foundItem) {
      if (foundItem.id === activeId.value) {
        // 更新现有分类
        ipcRenderer.send("execute-sql", {
          sql: "UPDATE class SET className = ? WHERE id = ?",
          type: "update",
          params: [item.className, item.id],
          responseEvent: "sql-result-class",
        });
      } else {
        // 插入新分类
        ipcRenderer.send("execute-sql", {
          sql: "INSERT INTO class (id, className) VALUES (?, ?)",
          type: "insert",
          params: [item.id, item.className],
          responseEvent: "sql-result-class",
        });
      }
    }
    item.isEdit = false;
    activeId.value = "";
    // 清空itemList的id
    deleteItemList();
    getAllClass();
  }
};

// 修改isActive => classitem被选中
const changeIsActive = (item: any) => {
  allClassActive.value = false;
  noClassActive.value = false;
  AllClass.value.forEach((element: any) => {
    element.isActive = false;
  });
  item.isActive = true;
  activeId.value = item.id;
  ipcRenderer.send("get-id", {
    id: activeId.value,
    responseEvent: "classList-id",
  });
  // 清空editContentBox组件的id
  deleteEditContent()
};

// 修改class
const changClass = () => {
  AllClass.value.forEach((item: any) => {
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
  // console.log(itemToDelete);

  if (itemToDelete) {
    ipcRenderer.send("execute-sql", {
      sql: "DELETE FROM class WHERE id = ?",
      type: "del",
      params: [activeId.value],
      responseEvent: "sql-result-class",
    });

    // 删除成功后将该分组下额所有笔记都删除
    ipcRenderer.send("execute-sql", {
      sql: "DELETE FROM notes WHERE classId = ?",
      type: "del",
      params: [activeId.value],
      responseEvent: "sql-result-notes",
    });
    // 删除后将editContentBox组件的id设置为空
    ipcRenderer.send("get-id", {
      id: "",
      responseEvent: "NodeList-id",
    });
    // 清空itemList的id
    deleteItemList();
    getAllClass();
  }
};

// 所有分组
const getAllClassNote = () => {
  allClassActive.value = true;
  noClassActive.value = false;
  ipcRenderer.send("get-id", {
    id: "",
    responseEvent: "classList-id",
  });
  AllClass.value.forEach((item) => (item.isActive = false)); // 取消其他项目的激活状态
  
};

// 未分组
const getNoteNoClass = () => {
  allClassActive.value = false;
  noClassActive.value = true;
  ipcRenderer.send("get-id", {
    id: "noClass",
    responseEvent: "classList-id",
  });
  AllClass.value.forEach((item) => (item.isActive = false)); // 取消其他项目的激活状态
};

// 清空传递给itemListBox组件的id
const deleteItemList = () => {
  // 删除后将传递给itemList的id设置为空
  activeId.value = "";
  ipcRenderer.send("get-id", {
    id: '',
    responseEvent: "classList-id",
  });
};
// 将editContentBox组件的id设置为空
const deleteEditContent = () => {
  ipcRenderer.send("get-id", {
    id: "",
    responseEvent: "NodeList-id",
  });
};


</script>

<style scoped>
.classBox {
  width: 179px;
  height: 100vh;
  display: flex;
  flex-direction: column;
  border-right: #b1b1b173 1px solid;
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
  background-color: #7a7a7a33;
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
