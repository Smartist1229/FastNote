import { useState, useEffect, useRef, useCallback } from 'react';
import { Editor, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import MdEditor from 'react-markdown-editor-lite';
import MarkdownIt from 'markdown-it';
import 'react-markdown-editor-lite/lib/index.css';
import { Note, Category } from '../types';
import { monacoEditorConfig } from '../config/monacoEditor';
import { mdEditorConfig } from '../config/mdEditor';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useToast } from './Toast';

loader.config({ monaco });

const mdParser = new MarkdownIt({
  html: true, // 启用 HTML 标签解析
  linkify: true, // 自动链接
  typographer: true, // 启用一些语言替换和引号美化
  breaks: true, // 回车换行
});

type EditorType = 'monaco' | 'markdown';

interface NoteEditorProps {
  note: Note | null;
  categories: Category[];
  onSave: (title: string, content: string, categoryId: number | null) => void;
  onDelete: () => void;
}

export const NoteEditor: React.FC<NoteEditorProps> = ({
  note,
  categories,
  onSave,
  onDelete,
}) => {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [editorType, setEditorType] = useState<EditorType>('monaco');
  const [isComposing, setIsComposing] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const lastNoteIdRef = useRef<number | null>(null);
  const latestTitleRef = useRef('');
  const latestContentRef = useRef('');
  const latestCategoryIdRef = useRef<number | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const { showToast } = useToast();

  const handleExport = async () => {
    if (!note) return;

    try {
      const defaultFileName = title || '笔记';
      
      const selectedPath = await save({
        defaultPath: `${defaultFileName}.txt`,
        filters: [
          { name: 'Plain Text', extensions: ['txt'] },
          { name: 'JavaScript', extensions: ['js'] },
          { name: 'TypeScript', extensions: ['ts'] },
          { name: 'Python', extensions: ['py'] },
          { name: 'Java', extensions: ['java'] },
          { name: 'C', extensions: ['c'] },
          { name: 'C++', extensions: ['cpp', 'h'] },
          { name: 'C#', extensions: ['cs'] },
          { name: 'Ruby', extensions: ['rb'] },
          { name: 'PHP', extensions: ['php'] },
          { name: 'HTML', extensions: ['html', 'htm'] },
          { name: 'CSS', extensions: ['css'] },
          { name: 'Markdown', extensions: ['md'] },
          { name: 'JSON', extensions: ['json'] },
          { name: 'XML', extensions: ['xml'] },
          { name: 'YAML', extensions: ['yaml', 'yml'] },
          { name: 'LaTeX', extensions: ['tex'] },
          { name: 'Configuration', extensions: ['conf', 'cfg', 'ini'] },
          { name: 'Shell Script', extensions: ['sh', 'bash'] },
          { name: 'PowerShell', extensions: ['ps1'] },
          { name: 'Batch', extensions: ['bat', 'cmd'] },
          { name: 'SQL', extensions: ['sql'] },
          { name: 'Rust', extensions: ['rs'] },
          { name: 'Go', extensions: ['go'] },
          { name: 'Swift', extensions: ['swift'] },
          { name: 'Kotlin', extensions: ['kt'] },
          { name: 'R', extensions: ['r'] },
          { name: 'Scala', extensions: ['scala'] },
          { name: 'Visual Basic', extensions: ['vb'] },
          { name: 'Perl', extensions: ['pl'] },
          { name: 'Lua', extensions: ['lua'] },
          { name: 'Dockerfile', extensions: ['dockerfile'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (selectedPath) {
        await writeTextFile(selectedPath, content);
        showToast('保存成功！', 'success');
      }
    } catch (error) {
      console.error('导出失败:', error);
      showToast('导出失败，请重试', 'error');
    }
  };

  useEffect(() => {
    if (note && note.id !== lastNoteIdRef.current) {
      setTitle(note.title);
      setContent(note.content);
      setCategoryId(note.category_id);
      latestTitleRef.current = note.title;
      latestContentRef.current = note.content;
      latestCategoryIdRef.current = note.category_id;
      lastNoteIdRef.current = note.id;
      setEditorKey(prev => prev + 1);
      
      if (note.title === '新笔记' && titleInputRef.current) {
        setTimeout(() => {
          titleInputRef.current?.focus();
          titleInputRef.current?.select();
        }, 100);
      }
    } else if (!note) {
      setTitle('');
      setContent('');
      setCategoryId(null);
      latestTitleRef.current = '';
      latestContentRef.current = '';
      latestCategoryIdRef.current = null;
      lastNoteIdRef.current = null;
    }
  }, [note]);

  const saveNow = useCallback(() => {
    if (isComposing || !note) return;
    onSave(
      latestTitleRef.current,
      latestContentRef.current,
      latestCategoryIdRef.current
    );
  }, [isComposing, note, onSave]);

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTitle = e.target.value;
    setTitle(newTitle);
    latestTitleRef.current = newTitle;
    if (!isComposing) {
      saveNow();
    }
  };

  const handleContentChange = (value: string | undefined) => {
    const newContent = value || '';
    setContent(newContent);
    latestContentRef.current = newContent;
    if (!isComposing) {
      saveNow();
    }
  };

  const handleCategoryChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    const newCategoryId = value ? parseInt(value) : null;
    setCategoryId(newCategoryId);
    latestCategoryIdRef.current = newCategoryId;
    saveNow();
  };

  const handleCompositionStart = () => {
    setIsComposing(true);
  };

  const handleCompositionEnd = () => {
    setIsComposing(false);
    saveNow();
  };

  const handleCopyContent = async () => {
    try {
      await navigator.clipboard.writeText(content);
      showToast('内容已复制到剪贴板', 'success');
    } catch (err) {
      console.error('复制失败:', err);
      showToast('复制失败', 'error');
    }
  };

  if (!note) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
        <p>选择一个笔记或创建新笔记</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-3 border-b border-gray-200 flex-shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <input
            ref={titleInputRef}
            type="text"
            value={title}
            onChange={handleTitleChange}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            placeholder="笔记标题"
            className="flex-1 px-3 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:border-transparent text-base font-medium shadow-sm"
          />
          <button
            onClick={onDelete}
            className="px-3 py-1.5 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors shadow-sm text-sm"
          >
            删除
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={categoryId?.toString() || ''}
            onChange={handleCategoryChange}
            className="w-40 px-3 py-1.5 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:border-transparent shadow-sm text-sm"
          >
            <option value="">无分类</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id.toString()}>
                {cat.name}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1 bg-gray-100 rounded px-2 py-1">
            <span className="text-xs text-gray-600">字数:</span>
            <span className="text-xs font-semibold text-gray-800">{content.length}</span>
          </div>

          <button
            onClick={handleExport}
            className="p-1.5 hover:bg-gray-100 rounded transition-colors"
            title="导出笔记"
          >
            <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </button>

          <button
            onClick={handleCopyContent}
            className="p-1.5 hover:bg-gray-100 rounded transition-colors"
            title="复制内容"
          >
            <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>

          <button
            onClick={() => setEditorType(editorType === 'monaco' ? 'markdown' : 'monaco')}
            className="p-1.5 hover:bg-gray-100 rounded transition-colors"
            title={`切换到${editorType === 'monaco' ? 'MdEditor' : 'MonacoEditor'}`}
          >
            <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {editorType === 'monaco' ? (
          <Editor
            key={editorKey}
            height="100%"
            defaultLanguage="markdown"
            value={content}
            onChange={handleContentChange}
            options={monacoEditorConfig as any}
          />
        ) : (
          <div 
            className="h-full"
            onClick={async (e) => {
              const target = e.target as HTMLElement;
              const link = target.closest('a');
              if (link && link.href) {
                e.preventDefault();
                try {
                  await openUrl(link.href);
                } catch (error) {
                  console.error('Failed to open link:', error);
                }
              }
            }}
          >
            <MdEditor
              value={content}
              onChange={({ text }) => {
                const newContent = text || '';
                setContent(newContent);
                latestContentRef.current = newContent;
                if (!isComposing) {
                  saveNow();
                }
              }}
              renderHTML={(text) => {
                const html = mdParser.render(text);
                return html;
              }}
              style={{ height: '100%' }}
              config={mdEditorConfig as any}
            />
          </div>
        )}
      </div>
    </div>
  );
};
