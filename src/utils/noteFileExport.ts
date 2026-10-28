/**
 * 笔记导出：系统保存对话框 + Tauri fs 写文本。
 * 不做格式转换——写出的始终是笔记原文，扩展名只影响文件名。
 */
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';

import { TEXT_FORMAT_GROUPS } from '@/config/textFileFormats';
import { t } from '@/i18n';

/**
 * 保存对话框的格式过滤器（编辑器 Ctrl+S 与侧边栏右键「保存笔记」共用）。
 * 一种格式一个条目：用户选中哪项，系统就按该项的扩展名补后缀，因此不按分组聚合。
 * 每次打开时翻译，不能在模块初始化时固定语言。
 */
const buildNoteFileFilters = () => TEXT_FORMAT_GROUPS.flatMap((group) =>
  group.formats.map((format) => ({ name: t(format.name), extensions: [format.ext] }))
);

/**
 * 弹出系统保存对话框，把笔记内容原样写入用户选定的文件。
 *
 * 副作用：打开系统保存对话框并写磁盘。
 *
 * @param title   默认文件名；空标题回退「无标题笔记」
 * @param content 笔记正文，按纯文本写入，不做转义
 * @returns 用户取消对话框返回 false，写入成功返回 true
 * @throws 写文件失败时抛出底层错误，由调用方决定如何提示
 */
export const saveNoteAsFile = async (title: string, content: string): Promise<boolean> => {
  const filePath = await save({
    defaultPath: title || t('无标题笔记'),
    filters: buildNoteFileFilters(),
  });
  if (!filePath) return false;
  await writeTextFile(filePath, content);
  return true;
};