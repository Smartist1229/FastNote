"use strict";const{app:E,BrowserWindow:R,ipcMain:d}=require("electron"),a=require("path"),i=require("better-sqlite3");let p=a.resolve(E.getPath("userData"),"noteData.db");const u=new i(p,{mode:i.OPEN_READWRITE|i.OPEN_CREATE});u.exec(`
  CREATE TABLE IF NOT EXISTS class (
    id TEXT PRIMARY KEY,
    className TEXT DEFAULT '未命名分组'
  );
`);u.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    title TEXT DEFAULT '未命名笔记',
    date TEXT NOT NULL,
    content TEXT,
    classId TEXT
  );
`);let c;process.env.ELECTRON_DISABLE_SECURITY_WARNINGS="true";const T=()=>{c=new R({icon:a.join(__dirname,"resource/Icon/shortcut256.ico"),width:1e3,height:700,minWidth:800,minHeight:300,webPreferences:{contextIsolation:!0,enableRemoteModule:!1,nodeIntegration:!1,preload:a.join(__dirname,"./electron/preload.ts")},resizable:!0}),c.setMenu(null),process.env.VITE_DEV_SERVER_URL?(c.loadURL(process.env.VITE_DEV_SERVER_URL),c.webContents.openDevTools()):c.loadFile(a.join(__dirname,"dist/index.html"))};E.whenReady().then(()=>{T(),E.on("activate",()=>{R.getAllWindows().length===0&&T()})});d.on("execute-sql",(e,{sql:r,type:n,params:t=[],responseEvent:l})=>{if(!l){e.reply("sql-result",{success:!1,error:"Missing responseEvent parameter"});return}try{const s=u.prepare(r);let o;switch(n){case"findAll":o=s.all(t);break;case"findOne":o=s.get(t);break;case"insert":o=s.run(t);break;case"update":o=s.run(t);break;case"del":o=s.run(t);break;default:throw new Error("传入的类型错误")}e.reply(l,{success:!0,result:o})}catch(s){e.reply(l,{success:!1,error:s.message})}});d.on("get-id",(e,{id:r,responseEvent:n})=>{e.reply(n,{success:!0,id:r})});d.on("update-content",(e,{id:r,title:n,content:t})=>{r&&n?e.reply("update-content",{success:!0,id:r,title:n,content:t}):e.reply("update-content",{success:!1,error:"参数不能为空"})});
