import Database, * as BetterSqlite3 from 'better-sqlite3'
import { app } from 'electron';
import { resolve } from 'path';

// userData => win:%APPDATA%, mac:~/Library/Application Support, linux:~/.config
const file = resolve(app.getPath('userData'), 'data.db');
// 有数据库就打开，没有就创建
const db: BetterSqlite3.Database = new Database(file, {
  // 可以添加其他配置选项
});

// 设置 journal_mode 为 WAL
db.pragma('journal_mode = WAL');

function closeDatabase(){
    db.close();
}
export { db, closeDatabase };