import { useEffect, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { Category, Note } from '../types';
import * as api from '../api';
import type { CategoryZipFormat, CategoryEbookFormat } from '../api';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { useToast } from './Toast';

interface ExportCategoryModalProps {
  /** 要导出的分组：为 null 时窗口关闭 */
  category: Category | null;
  onClose: () => void;
  /** 导出结束后通知外部刷新（笔记数可能变化） */
  onDone?: () => void;
}

/** 格式选项：value 由各自的 Format 类型约束，这里统一成 string 便于两类共用一份渲染 */
type FormatOption = { value: string; label: string; ext: string; desc: string };

/** 压缩包内笔记的文件格式 */
const ZIP_FORMATS: FormatOption[] = [
  { value: 'md', label: 'Markdown', ext: 'md', desc: '原文直出，保真度最高' },
  { value: 'txt', label: '纯文本', ext: 'txt', desc: '内容同 Markdown 原文' },
  { value: 'html', label: '网页', ext: 'html', desc: '渲染成可直接打开的网页' },
  { value: 'json', label: 'JSON', ext: 'json', desc: '含标题、正文、时间等字段' },
];

/** 电子书格式 */
const EBOOK_FORMATS: FormatOption[] = [
  { value: 'txt', label: 'TXT', ext: 'txt', desc: '单文件，通用性最好' },
  { value: 'html', label: 'HTML', ext: 'html', desc: '单文件带目录，浏览器可看' },
  { value: 'epub', label: 'EPUB', ext: 'epub', desc: '标准电子书，可导入阅读器' },
];

const errorText = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e));

/**
 * 导出分组：压缩包（一篇笔记一个文件）或电子书（整组一个文件）。
 * 章节顺序为创建时间正序，最早创建的笔记在最前；章节名即笔记标题。
 */
export const ExportCategoryModal: React.FC<ExportCategoryModalProps> = ({ category, onClose, onDone }) => {
  const { showToast } = useToast();
  const [mode, setMode] = useState<'zip' | 'ebook'>('zip');
  const [zipFormat, setZipFormat] = useState<CategoryZipFormat>('md');
  const [ebookFormat, setEbookFormat] = useState<CategoryEbookFormat>('txt');
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loadingNotes, setLoadingNotes] = useState(false);
  // 选中的笔记 ID：默认全选，用 Set 方便查找
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // 每次打开都回到默认选项，避免上次的选择让人困惑
  useEffect(() => {
    if (category) {
      setMode('zip');
      setZipFormat('md');
      setEbookFormat('txt');
      setBusy(false);
      // 加载分组下的所有笔记，默认全选
      setLoadingNotes(true);
      api
        .getNotes(category.id, 'created_at', 'asc')
        .then((ns) => {
          setNotes(ns);
          setSelectedIds(new Set(ns.map((n) => n.id)));
        })
        .catch(() => {
          setNotes([]);
          setSelectedIds(new Set());
        })
        .finally(() => setLoadingNotes(false));
    }
  }, [category]);

  // 全选 / 取消全选
  const allSelected = notes.length > 0 && notes.every((n) => selectedIds.has(n.id));
  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(notes.map((n) => n.id)));
    }
  };

  // 当前选中的笔记 ID 列表，按原顺序
  const selectedNoteIds = notes
    .filter((n) => selectedIds.has(n.id))
    .map((n) => n.id);

  const isZip = mode === 'zip';
  const formats: FormatOption[] = isZip ? ZIP_FORMATS : EBOOK_FORMATS;
  const format = isZip ? zipFormat : ebookFormat;
  const current = formats.find((f) => f.value === format) ?? formats[0];

  const handleExport = async () => {
    if (!category || selectedNoteIds.length === 0) return;
    try {
      const path = await save({
        // 压缩包模式默认文件名固定为 .zip（不能用内层笔记的扩展名）
        defaultPath: isZip ? `${category.name}.zip` : `${category.name}.${current.ext}`,
        filters: [
          isZip
            ? { name: 'ZIP 压缩包', extensions: ['zip'] }
            : { name: current.label, extensions: [current.ext] },
        ],
      });
      if (!path) return;

      setBusy(true);
      const count = isZip
        ? await api.exportNotesZip(selectedNoteIds, path, zipFormat)
        : await api.exportNotesEbook(selectedNoteIds, path, ebookFormat);
      showToast(`已导出 ${count} 篇笔记`, 'success');
      onDone?.();
      onClose();
    } catch (e) {
      showToast(`导出失败：${errorText(e)}`, 'error');
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={!!category} onClose={onClose} title="导出笔记">
      <div className="space-y-4">
        <p className="text-xs text-slate-500">
          分组：<span className="font-medium text-slate-700">{category?.name}</span>
          <span className="ml-2 text-slate-400">章节按创建时间正序，最早创建的笔记在最前面</span>
        </p>

        {/* 导出类型 */}
        <div>
          <p className="text-xs font-medium text-slate-600 mb-2">导出为</p>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setMode('zip')}
              className={`flex items-start gap-2.5 p-3 rounded-xl border text-left transition-colors ${
                isZip ? 'border-primary-300 bg-primary-50' : 'border-slate-200 hover:bg-slate-50'
              }`}
            >
              <Icon name="app-backup" className={`w-4 h-4 mt-0.5 flex-shrink-0 ${isZip ? 'text-primary-500' : 'text-slate-400'}`} />
              <span className="min-w-0">
                <span className={`block text-sm font-medium ${isZip ? 'text-primary-600' : 'text-slate-600'}`}>压缩包</span>
                <span className="block text-[11px] text-slate-400 mt-0.5">一篇笔记一个文件</span>
              </span>
            </button>
            <button
              onClick={() => setMode('ebook')}
              className={`flex items-start gap-2.5 p-3 rounded-xl border text-left transition-colors ${
                !isZip ? 'border-primary-300 bg-primary-50' : 'border-slate-200 hover:bg-slate-50'
              }`}
            >
              <Icon name="editor-export" className={`w-4 h-4 mt-0.5 flex-shrink-0 ${!isZip ? 'text-primary-500' : 'text-slate-400'}`} />
              <span className="min-w-0">
                <span className={`block text-sm font-medium ${!isZip ? 'text-primary-600' : 'text-slate-600'}`}>电子书</span>
                <span className="block text-[11px] text-slate-400 mt-0.5">整组合成一本书</span>
              </span>
            </button>
          </div>
        </div>

        {/* 文件格式 */}
        <div>
          <p className="text-xs font-medium text-slate-600 mb-2">文件格式</p>
          <div className="flex flex-wrap gap-1.5">
            {formats.map((f) => (
              <button
                key={f.value}
                onClick={() => (isZip ? setZipFormat(f.value as CategoryZipFormat) : setEbookFormat(f.value as CategoryEbookFormat))}
                title={f.desc}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  format === f.value
                    ? 'border-primary-300 bg-primary-50 text-primary-600'
                    : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-slate-400 mt-2">
            {isZip ? `压缩包里每篇笔记一个 .${current.ext} 文件` : `整组导出为单个 .${current.ext} 文件`}
            {isZip ? '' : '，章节名就是笔记标题'}
          </p>
        </div>

        {/* 笔记选择：默认全选，取消不需要的 */}
        
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium text-slate-600 flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = notes.length > 0 && !allSelected;
                }}
                onChange={toggleAll}
                className="w-3.5 h-3.5 rounded border-slate-300 text-primary-500 focus:ring-primary-300"
              />
              选择笔记 ({selectedIds.size}/{notes.length})
            </label>
            <span className="text-[11px] text-slate-400">
              {selectedNoteIds.length} 个已选中
            </span>
          </div>

          {loadingNotes ? (
            <div className="text-xs text-slate-400 py-4 text-center">加载笔记中...</div>
          ) : (
            <div className="max-h-48 overflow-y-auto border border-slate-200 rounded-lg bg-slate-50">
              {notes.map((note) => {
                const checked = selectedIds.has(note.id);
                return (
                  <label
                    key={note.id}
                    className="flex items-center gap-2 px-2.5 py-1.5 text-xs cursor-pointer hover:bg-slate-100 transition-colors first:rounded-t-lg last:rounded-b-lg"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const next = new Set(selectedIds);
                        if (e.target.checked) {
                          next.add(note.id);
                        } else {
                          next.delete(note.id);
                        }
                        setSelectedIds(next);
                      }}
                      className="w-3.5 h-3.5 rounded border-slate-300 text-primary-500 focus:ring-primary-300"
                    />
                    <span
                      className="truncate min-w-0 flex-1"
                      title={note.title}
                    >
                      {note.title || '无标题笔记'}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="btn-ghost px-4 py-2 text-sm">
            取消
          </button>
          <button
            onClick={handleExport}
            disabled={busy || selectedNoteIds.length === 0}
            className="btn-primary px-4 py-2 text-sm disabled:opacity-50"
          >
            {busy ? '导出中...' : '导出'}
          </button>
        </div>
      </div>
    </Modal>
  );
};