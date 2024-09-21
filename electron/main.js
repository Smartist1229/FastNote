const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');

const emitter = require('events');
const myEmitter = new emitter.EventEmitter();

// 增加最大监听器数量
myEmitter.setMaxListeners(50);

// 创建数据库文件：判断是否是开发模式，根据开发模式选择数据库路径
let dir;
if (process.env.VITE_DEV_SERVER_URL) {
  dir = path.resolve(app.getPath('userData'), 'notedbdata.noteData');
} else {
  dir = path.resolve(process.resourcesPath, 'notedbdata.noteData');
}

// 创建或打开数据库
const db = new Database(dir, {
  mode: Database.OPEN_READWRITE | Database.OPEN_CREATE
});

// 初始化数据表
db.exec(`
  CREATE TABLE IF NOT EXISTS class (
    id TEXT PRIMARY KEY,
    className TEXT DEFAULT '未命名分组'
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    title TEXT DEFAULT '未命名笔记',
    date TEXT NOT NULL,
    content TEXT,
    classId TEXT
  );
`);

// 主窗口（进程）
let mainWindow;

process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';

// 创建主进程
const createWindow = () => {
  mainWindow = new BrowserWindow({
    icon: path.join(__dirname, '../resource/Icon/shortcut256.ico'),
    show: false, // 先取消显示
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 300,
    webPreferences: {
      contextIsolation: true,
      enableRemoteModule: false,
      nodeIntegration: false,
      preload: path.join(__dirname, './preload.ts') // 使用 preload.js
    },
    resizable: true,
  });

  mainWindow.setMenu(null);
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // 当页面渲染完成后再加载页面（防止页面白屏）
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.show();
  });

  // 监听 new-window 事件，阻止新窗口的打开
  mainWindow.webContents.on('new-window', (event, url) => {
    event.preventDefault();
    // 如果需要的话，可以在这里处理url，例如在当前窗口加载该url
    // mainWindow.loadURL(url);
    shell.openExternal(url);
  });
};

// 渲染进程消息处理
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.on('execute-sql', (event, { sql, type, params = [], responseEvent }) => {
  if (!responseEvent) {
    event.reply('sql-result', { success: false, error: 'Missing responseEvent parameter' });
    return;
  }

  try {
    const stmt = db.prepare(sql);
    let result;
    switch (type) {
      case 'findAll':
        result = stmt.all(params);
        break;
      case 'findOne':
        result = stmt.get(params);
        break;
      case 'insert':
        result = stmt.run(params);
        break;
      case 'update':
        result = stmt.run(params);
        break;
      case 'del':
        result = stmt.run(params);
        break;
      default:
        throw new Error('传入的类型错误');
    }
    event.reply(responseEvent, { success: true, result });
  } catch (error) {
    event.reply(responseEvent, { success: false, error: error.message });
  }
});

// 刷新页面(忽略缓存)
ipcMain.on('refresh', (event) => {
  mainWindow.reload({ ignoreCache: true });
});

// 测试路径
// ipcMain.on('app-path', (event,type) => {
//   event.reply('app-path', app.getPath(type));
// });
