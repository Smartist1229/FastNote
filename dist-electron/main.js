"use strict";const{app:d,BrowserWindow:p,ipcMain:l}=require("electron"),c=require("path"),E=require("better-sqlite3");let u;process.env.VITE_DEV_SERVER_URL?u=c.resolve(d.getPath("userData"),"notedbdata.noteData"):u=c.resolve(process.resourcesPath,"notedbdata.noteData");const T=new E(u,{mode:E.OPEN_READWRITE|E.OPEN_CREATE});T.exec(`
  CREATE TABLE IF NOT EXISTS class (
    id TEXT PRIMARY KEY,
    className TEXT DEFAULT '未命名分组'
  );
`);T.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    title TEXT DEFAULT '未命名笔记',
    date TEXT NOT NULL,
    content TEXT,
    classId TEXT
  );
`);let a;process.env.ELECTRON_DISABLE_SECURITY_WARNINGS="true";const R=()=>{a=new p({icon:c.join(__dirname,"../resource/Icon/shortcut256.ico"),width:1e3,height:700,minWidth:800,minHeight:300,webPreferences:{contextIsolation:!0,enableRemoteModule:!1,nodeIntegration:!1,preload:c.join(__dirname,"./preload.ts")},resizable:!0}),a.setMenu(null),process.env.VITE_DEV_SERVER_URL?(a.loadURL(process.env.VITE_DEV_SERVER_URL),a.webContents.openDevTools()):a.loadFile(c.join(__dirname,"../dist/index.html"))};d.whenReady().then(()=>{R(),d.on("activate",()=>{p.getAllWindows().length===0&&R()})});l.on("execute-sql",(e,{sql:t,type:s,params:r=[],responseEvent:i})=>{if(!i){e.reply("sql-result",{success:!1,error:"Missing responseEvent parameter"});return}try{const n=T.prepare(t);let o;switch(s){case"findAll":o=n.all(r);break;case"findOne":o=n.get(r);break;case"insert":o=n.run(r);break;case"update":o=n.run(r);break;case"del":o=n.run(r);break;default:throw new Error("传入的类型错误")}e.reply(i,{success:!0,result:o})}catch(n){e.reply(i,{success:!1,error:n.message})}});l.on("get-id",(e,{id:t,responseEvent:s})=>{e.reply(s,{success:!0,id:t})});l.on("update-content",(e,{id:t,title:s,content:r})=>{t&&s?e.reply("update-content",{success:!0,id:t,title:s,content:r}):e.reply("update-content",{success:!1,error:"参数不能为空"})});l.on("update-title",(e,{id:t,title:s})=>{e.reply("update-title",{success:!0,id:t,title:s})});
