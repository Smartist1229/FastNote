import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';

import { TEXT_FORMAT_GROUPS } from '@/config/textFileFormats';

/**
 * 导出笔记时的可选文件类型（编辑器 Ctrl+S 与侧边栏右键「保存笔记」共用）。
 * 原生保存对话框不支持分组：一个过滤器被选中后只会补它的第一个后缀，
 * 所以这里把白名单摊平——一种格式一个条目，选 Markdown 就会补 .md。
 */
const NOTE_FILE_FILTERS = TEXT_FORMAT_GROUPS.flatMap((group) =>
  group.formats.map((format) => ({ name: format.name, extensions: [format.ext] }))
);

/**
 * 弹出保存窗口，把笔记内容写入用户选定的文件。
 * 用户取消时返回 false；写入失败会抛错，由调用方决定怎么提示。
 */
export const saveNoteAsFile = async (title: string, content: string): Promise<boolean> => {
  const filePath = await save({
    defaultPath: title || '无标题笔记',
    filters: NOTE_FILE_FILTERS,
  });
  if (!filePath) return false;
  await writeTextFile(filePath, content);
  return true;
};