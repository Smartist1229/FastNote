import { useEffect, useMemo, useRef, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import type { Note } from "@/interface/note";
import type { CategoryEbookFormat, NoteFormatSpec } from "@/interface/backup";
import type { ExportCategoryModalProps, FormatOption, ZipFormatChoice } from "@/interface/exportCategory";
import * as exportApi from "@/api/export";
import { Modal } from '@/components/common/Modal';
import { Icon } from '@/components/common/Icon';
import { useToast } from '@/components/common/Toast';
import { TextExtPicker } from '@/components/data/TextExtPicker';
import { DEFAULT_TEXT_EXT } from '@/config/textFileFormats';

/** 压缩包内笔记的文件格式：预设四种，或逐篇自选 */
const ZIP_FORMATS: FormatOption[] = [
  { value: 'md', label: 'Markdown', ext: 'md', desc: '原文直出，保真度最高' },
  { value: 'txt', label: '纯文本', ext: 'txt', desc: '内容同 Markdown 原文' },
  { value: 'html', label: '网页', ext: 'html', desc: '渲染成可直接打开的网页' },
  { value: 'json', label: 'JSON', ext: 'json', desc: '含标题、正文、时间等字段' },
  { value: 'other', label: '其他文件格式', ext: '', desc: '逐篇自选后缀，仅限纯文本格式' },
];

/** 电子书格式 */
const EBOOK_FORMATS: FormatOption[] = [
  { value: 'txt', label: 'TXT', ext: 'txt', desc: '单文件，通用性最好' },
  { value: 'html', label: 'HTML', ext: 'html', desc: '单文件带目录，浏览器可看' },
  { value: 'epub', label: 'EPUB', ext: 'epub', desc: '标准电子书，可导入阅读器' },
];

const errorText = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : String(e));

/**
 * 分组导出弹窗：把 target.notes 导出为「压缩包」（一篇笔记一个文件）
 * 或「电子书」（整组合成一个文件）。压缩包内按创建时间正序；
 * 电子书章节默认也按创建时间正序，但可在列表里拖动调整，导出顺序以拖拽结果为准。
 * 章节名即笔记标题。
 *
 * - target：真实分组 / 默认分组 / 搜索结果分组都归一成同一结构，为 null 时不展示内容
 * - onDone：导出成功后通知外部刷新；随后 onClose 关闭弹窗
 * - 副作用：调 Tauri dialog 的 save 选路径、调 exportApi 写盘、Toast 提示结果
 *
 * 「其他文件格式」只在压缩包模式下出现，逐篇后缀受纯文本白名单约束。
 */
export const ExportCategoryModal: React.FC<ExportCategoryModalProps> = ({ target, onClose, onDone }) => {
  const { showToast } = useToast();
  const [mode, setMode] = useState<'zip' | 'ebook'>('zip');
  const [zipFormat, setZipFormat] = useState<ZipFormatChoice>('md');
  const [ebookFormat, setEbookFormat] = useState<CategoryEbookFormat>('txt');
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  /** 文件名（不含扩展名）：默认取分组推导出的名称，可手动改 */
  const [fileName, setFileName] = useState('');
  // 选中的笔记用 Set 存 id，逐篇勾选时判断 O(1)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  /** 「其他文件格式」模式下每篇笔记自己的后缀，没改过的用 DEFAULT_TEXT_EXT */
  const [otherExts, setOtherExts] = useState<Record<number, string>>({});
  /** 正在挑后缀的笔记，以及浮层贴着的位置 */
  const [pickerFor, setPickerFor] = useState<{ noteId: number; anchor: DOMRect } | null>(null);
  /**
   * 电子书章节顺序（笔记 id）。压缩包仍用 notes 的创建时间顺序，
   * 因此这里单独维护，切换格式时不会把压缩包的顺序也改掉。
   */
  const [ebookOrder, setEbookOrder] = useState<number[]>([]);
  /** 拖拽中的笔记 / 当前悬停的目标行，仅用于视觉反馈 */
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  // 指针事件回调里要读最新值，state 在同一轮事件中可能还没刷新
  const dragRef = useRef<{ pointerId: number; startY: number; active: boolean; noteId: number } | null>(null);
  const dragOverRef = useRef<number | null>(null);

  // 每次打开都回到默认选项，避免上次的选择让人困惑
  useEffect(() => {
    if (!target) return;
    setMode('zip');
    setZipFormat('md');
    setEbookFormat('txt');
    setBusy(false);
    setFileName(target.defaultFileName);
    setOtherExts({});
    setPickerFor(null);
    // 章节顺序按创建时间正序，时间相同再按 id 兜底
    const sorted = [...target.notes].sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id
    );
    setNotes(sorted);
    setEbookOrder(sorted.map((n) => n.id));
    setSelectedIds(new Set(sorted.map((n) => n.id)));
    setDraggingId(null);
    setDragOverId(null);
    dragRef.current = null;
    dragOverRef.current = null;
  }, [target]);

  const isZip = mode === 'zip';

  /** 列表展示顺序 = 导出顺序：压缩包按创建时间，电子书按拖拽后的 ebookOrder */
  const noteById = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes]);
  const orderedNotes = useMemo(() => {
    if (isZip) return notes;
    const ordered = ebookOrder
      .map((id) => noteById.get(id))
      .filter((note): note is Note => !!note);
    // 顺序表尚未同步时把漏掉的笔记补在末尾，避免列表短暂丢行
    if (ordered.length !== notes.length) {
      const seen = new Set(ordered.map((note) => note.id));
      for (const note of notes) {
        if (!seen.has(note.id)) ordered.push(note);
      }
    }
    return ordered;
  }, [isZip, notes, ebookOrder, noteById]);

  const allSelected = orderedNotes.length > 0 && orderedNotes.every((n) => selectedIds.has(n.id));
  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(orderedNotes.map((n) => n.id)));
    }
  };

  // 过滤后的顺序就是导出顺序：压缩包按创建时间，电子书按用户拖拽结果
  const selectedNoteIds = orderedNotes
    .filter((n) => selectedIds.has(n.id))
    .map((n) => n.id);

  /** 电子书章节拖拽：指针拖动比 HTML5 DnD 稳（窗口开启了 Tauri 原生文件拖放，会干扰 DnD） */
  const beginEbookDrag = (event: React.PointerEvent<HTMLElement>, noteId: number) => {
    if (isZip) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, active: false, noteId };
  };

  const moveEbookDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active) {
      if (Math.abs(event.clientY - drag.startY) < 4) return;
      drag.active = true;
      setDraggingId(drag.noteId);
    }
    const row = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-ebook-drag-id]');
    const raw = row?.dataset.ebookDragId;
    const overId = raw ? Number(raw) : null;
    const next = overId !== null && overId !== drag.noteId ? overId : null;
    dragOverRef.current = next;
    setDragOverId(next);
  };

  const endEbookDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const targetId = dragOverRef.current;
    dragOverRef.current = null;
    setDraggingId(null);
    setDragOverId(null);
    if (!drag.active || targetId === null || targetId === drag.noteId) return;
    setEbookOrder((prev) => {
      const from = prev.indexOf(drag.noteId);
      const to = prev.indexOf(targetId);
      if (from < 0 || to < 0 || from === to) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  /** 压缩包逐篇自选后缀：每篇笔记可能不一样 */
  const isOtherExt = isZip && zipFormat === 'other';
  const noteExt = (id: number) => otherExts[id] ?? DEFAULT_TEXT_EXT;
  const formats: FormatOption[] = isZip ? ZIP_FORMATS : EBOOK_FORMATS;
  const format = isZip ? zipFormat : ebookFormat;
  const current = formats.find((f) => f.value === format) ?? formats[0];

  /** 选路径 → 调 exportApi 写盘 → 提示篇数并关闭；失败保留弹窗、复位 busy 便于重试 */
  const handleExport = async () => {
    if (!target || selectedNoteIds.length === 0) return;
    // 文件名留空时退回默认名，去掉路径分隔符等非法字符
    const baseName = (fileName.trim() || target.defaultFileName).replace(/[\\/:*?"<>|]/g, '_');
    try {
      const path = await save({
        // 压缩包模式默认文件名固定为 .zip（不能用内层笔记的扩展名）
        defaultPath: isZip ? `${baseName}.zip` : `${baseName}.${current.ext}`,
        filters: [
          isZip
            ? { name: 'ZIP 压缩包', extensions: ['zip'] }
            : { name: current.label, extensions: [current.ext] },
        ],
      });
      if (!path) return;

      setBusy(true);
      const count = isZip
        ? await exportApi.exportNotesZip(
            selectedNoteIds,
            path,
            zipFormat === 'other' ? DEFAULT_TEXT_EXT : zipFormat,
            isOtherExt
              ? selectedNoteIds.map<NoteFormatSpec>((id) => ({ id, ext: noteExt(id) }))
              : undefined,
          )
        : await exportApi.exportNotesEbook(selectedNoteIds, path, ebookFormat);
      showToast(`已导出 ${count} 篇笔记`, 'success');
      onDone?.();
      onClose();
    } catch (e) {
      showToast(`导出失败：${errorText(e)}`, 'error');
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={!!target} onClose={onClose} title="导出笔记">
      <div className="space-y-4">
        <p className="text-xs text-muted">
          分组：<span className="font-medium text-body">{target?.name}</span>
          <span className="ml-2 text-faint">
            {isZip
              ? '压缩包内按创建时间正序，最早创建的笔记在最前面'
              : '电子书章节按下方列表顺序排列，可拖动左侧手柄调整'}
          </span>
        </p>

        {/* 文件名：默认填好分组对应的名称，可改，也可一键填回默认 */}
        <div>
          <p className="text-xs font-medium text-body mb-2">文件名</p>
          <div className="flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <input
                type="text"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                placeholder={target?.defaultFileName ?? ''}
                className="w-full pl-3 pr-14 py-1.5 text-xs input-modern"
              />
              {/* 压缩包始终是 .zip，后缀不随内部笔记格式变化；电子书才是所选格式 */}
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-faint-soft pointer-events-none">
                .{isZip ? 'zip' : current.ext}
              </span>
            </div>
            <button
              onClick={() => setFileName(target?.defaultFileName ?? '')}
              className="btn-ghost px-3 py-1.5 text-xs flex-shrink-0"
              title="把文件名填回该分组对应的默认名称"
            >
              填充默认分组名
            </button>
          </div>
        </div>

        {/* 导出类型 */}
        <div>
          <p className="text-xs font-medium text-body mb-2">导出为</p>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setMode('zip')}
              className={`flex items-start gap-2.5 p-3 rounded-xl border text-left transition-colors ${
                isZip ? 'border-primary-300 bg-primary-50' : 'border-line hover:bg-app'
              }`}
            >
              <Icon name="app-backup" className={`w-4 h-4 mt-0.5 flex-shrink-0 ${isZip ? 'text-primary-500' : 'text-faint'}`} />
              <span className="min-w-0">
                <span className={`block text-sm font-medium ${isZip ? 'text-primary-600' : 'text-body'}`}>压缩包</span>
                <span className="block text-[11px] text-faint mt-0.5">一篇笔记一个文件</span>
              </span>
            </button>
            <button
              onClick={() => setMode('ebook')}
              className={`flex items-start gap-2.5 p-3 rounded-xl border text-left transition-colors ${
                !isZip ? 'border-primary-300 bg-primary-50' : 'border-line hover:bg-app'
              }`}
            >
              <Icon name="editor-export" className={`w-4 h-4 mt-0.5 flex-shrink-0 ${!isZip ? 'text-primary-500' : 'text-faint'}`} />
              <span className="min-w-0">
                <span className={`block text-sm font-medium ${!isZip ? 'text-primary-600' : 'text-body'}`}>电子书</span>
                <span className="block text-[11px] text-faint mt-0.5">整组合成一本书</span>
              </span>
            </button>
          </div>
        </div>

        {/* 文件格式 */}
        <div>
          <p className="text-xs font-medium text-body mb-2">文件格式</p>
          <div className="flex flex-wrap gap-1.5">
            {formats.map((f) => (
              <button
                key={f.value}
                onClick={() => (isZip ? setZipFormat(f.value as ZipFormatChoice) : setEbookFormat(f.value as CategoryEbookFormat))}
                title={f.desc}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  format === f.value
                    ? 'border-primary-300 bg-primary-50 text-primary-600'
                    : 'border-line text-muted hover:bg-app'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-faint mt-2">
            {!isZip
              ? `整组导出为单个 .${current.ext} 文件，章节名就是笔记标题`
              : isOtherExt
              ? '压缩包里每篇笔记一个文件，后缀按每篇笔记各自的选择（仅限纯文本格式）'
              : `压缩包里每篇笔记一个 .${current.ext} 文件`}
          </p>
        </div>

        {/* 笔记选择：默认全选，取消不需要的 */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium text-body flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = notes.length > 0 && !allSelected;
                }}
                onChange={toggleAll}
                className="w-3.5 h-3.5 rounded border-line-strong text-primary-500 focus:ring-primary-300"
              />
              选择笔记 ({selectedIds.size}/{notes.length})
            </label>
            <span className="text-[11px] text-faint">
              {selectedNoteIds.length} 个已选中
            </span>
          </div>

          <div className="max-h-48 overflow-y-auto border border-line rounded-lg bg-app">
            {orderedNotes.map((note, index) => {
              const checked = selectedIds.has(note.id);
              return (
                <div
                  key={note.id}
                  data-ebook-drag-id={isZip ? undefined : note.id}
                  className={`flex items-center gap-2 px-2.5 py-1.5 text-xs transition-colors first:rounded-t-lg last:rounded-b-lg ${
                    draggingId === note.id ? 'opacity-50 bg-primary-50' : 'hover:bg-surface-alt'
                  } ${dragOverId === note.id ? 'bg-primary-50 ring-1 ring-inset ring-primary-300' : ''}`}
                >
                  {/* 电子书可拖动排序；压缩包保持创建时间顺序，不显示手柄 */}
                  {!isZip && (
                    <>
                      <span
                        role="button"
                        tabIndex={-1}
                        title="拖动调整章节顺序"
                        aria-label={`拖动调整《${note.title || '无标题笔记'}》的章节顺序`}
                        onPointerDown={(e) => beginEbookDrag(e, note.id)}
                        onPointerMove={moveEbookDrag}
                        onPointerUp={endEbookDrag}
                        onPointerCancel={endEbookDrag}
                        className="flex-shrink-0 px-0.5 py-1 cursor-grab active:cursor-grabbing text-faint-soft hover:text-muted touch-none"
                      >
                        <svg viewBox="0 0 8 14" className="w-2 h-3.5" fill="currentColor" aria-hidden>
                          <circle cx="2" cy="2" r="1.1" />
                          <circle cx="6" cy="2" r="1.1" />
                          <circle cx="2" cy="7" r="1.1" />
                          <circle cx="6" cy="7" r="1.1" />
                          <circle cx="2" cy="12" r="1.1" />
                          <circle cx="6" cy="12" r="1.1" />
                        </svg>
                      </span>
                      <span className="w-4 flex-shrink-0 text-right text-[10px] text-faint-soft tabular-nums">
                        {index + 1}
                      </span>
                    </>
                  )}
                  <label className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
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
                      className="w-3.5 h-3.5 rounded border-line-strong text-primary-500 focus:ring-primary-300"
                    />
                    <span className="truncate min-w-0 flex-1" title={note.title}>
                      {note.title || '无标题笔记'}
                    </span>
                  </label>
                  {/* 压缩包里每篇笔记是独立文件，标注落盘后缀；电子书整组一个文件，无需后缀 */}
                  {isZip &&
                    (isOtherExt ? (
                      <button
                        onClick={(e) =>
                          setPickerFor({ noteId: note.id, anchor: e.currentTarget.getBoundingClientRect() })
                        }
                        className={`flex-shrink-0 px-1.5 py-0.5 rounded-md border text-[11px] transition-colors ${
                          pickerFor?.noteId === note.id
                            ? 'border-primary-300 bg-primary-50 text-primary-600'
                            : 'border-line bg-surface text-muted hover:border-primary-300 hover:text-primary-600'
                        }`}
                        title="选择这篇笔记的文件后缀"
                      >
                        .{noteExt(note.id)}
                      </button>
                    ) : (
                      <span className="text-[11px] text-faint flex-shrink-0">.{current.ext}</span>
                    ))}
                </div>
              );
            })}
          </div>
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

      {pickerFor && (
        <TextExtPicker
          anchor={pickerFor.anchor}
          value={noteExt(pickerFor.noteId)}
          onPick={(ext) => {
            setOtherExts((prev) => ({ ...prev, [pickerFor.noteId]: ext }));
            setPickerFor(null);
          }}
          onClose={() => setPickerFor(null)}
        />
      )}
    </Modal>
  );
};