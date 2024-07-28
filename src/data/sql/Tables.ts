import {db} from './index.mts';
import {nanoid} from 'nanoid';
import moment from 'moment';

export function initTable(){
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY DEFAULT '${nanoid()}',
            className TEXT NOT NULL DEFAULT '未分组'
        );
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY DEFAULT '${nanoid()}',
            title TEXT NOT NULL,
            date TEXT NOT NULL,
            content TEXT,
            classId TEXT
        );
    `);
    defaultData();
}

function defaultData(){
    db.exec(`INSERT INTO users (className) VALUES ('默认分组)`);
    db.exec(`INSERT INTO messages (title, date, content, classId) VALUES (ReadMe', , '此笔记用于测试（添加默认数据）', '1')`);
    db.exec(`INSERT INTO messages (title, date, content, classId) VALUES ('test', ${moment(new Date()).format('YYYY-MM-DD')}, '此笔记用于测试（添加默认数据）', '1'])`, );
}
