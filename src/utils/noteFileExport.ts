import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';

/** 导出笔记时的可选文件类型（编辑器 Ctrl+S 与侧边栏右键「保存笔记」共用） */
const NOTE_FILE_FILTERS = [
  { name: 'Plain Text', extensions: ['txt', 'text'] },
  { name: 'Markdown', extensions: ['md', 'mdx'] },
  { name: 'JSON', extensions: ['json', 'jsonc'] },
  { name: 'HTML', extensions: ['html', 'htm', 'xhtml'] },
  { name: 'Source Code', extensions: ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'css', 'scss', 'less'] },
  { name: 'Config File', extensions: ['ini', 'yaml', 'yml', 'toml', 'env'] },
  { name: 'Table Text', extensions: ['csv', 'tsv'] },
  { name: 'XML', extensions: ['xml', 'svg'] },
  { name: 'Log File', extensions: ['log'] },
  { name: 'All Files', extensions: ['*'] },
];

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