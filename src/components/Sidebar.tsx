import { useState } from 'react';
import { Category, Note } from '../types';
import * as api from '../api';
import { useToast } from './Toast';
import { ContextMenu, ContextMenuItem, useContextMenu } from './ContextMenu';

interface SidebarProps {
  categories: Category[];
  notes: Note[];
  selectedCategoryId: number | null;
  selectedNoteId: number | null;
  onSelectCategory: (id: number | null) => void;
  onCreateCategory: () => void;
  onEditCategory: (category: Category) => void;
  onDeleteCategory: (category: Category) => void;
  allNotesCount: number;
  onNotesUpdated: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  categories,
  notes,
  selectedCategoryId,
  selectedNoteId,
  onSelectCategory,
  onCreateCategory,
  onEditCategory,
  onDeleteCategory,
  allNotesCount,
  onNotesUpdated,
}) => {
  const [hoveredCategoryId, setHoveredCategoryId] = useState<number | null>(null);
  const [contextMenuCategory, setContextMenuCategory] = useState<Category | null>(null);
  const { menuPos, handleContextMenu, closeMenu } = useContextMenu();
  const { showToast } = useToast();

  const getCategoryMenuItems = (category: Category): ContextMenuItem[] => [
    {
      label: '选择分类',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ),
      onClick: () => onSelectCategory(category.id),
    },
    { divider: true, label: '', onClick: () => {} },
    {
      label: '编辑分类',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
        </svg>
      ),
      onClick: () => onEditCategory(category),
    },
    {
      label: '新建分类',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      ),
      onClick: () => onCreateCategory(),
    },
    { divider: true, label: '', onClick: () => {} },
    {
      label: '删除分类',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      ),
      onClick: () => onDeleteCategory(category),
      danger: true,
    },
  ];

  const createDragHandle = (categoryId: number) => {
    return {
      onDragOver: (e: React.DragEvent<HTMLButtonElement>) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const el = e.currentTarget as HTMLElement;
        el.style.background = 'linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%)';
        el.style.borderColor = '#a5b4fc';
      },
      onDragLeave: (e: React.DragEvent<HTMLButtonElement>) => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = '';
        el.style.borderColor = '';
      },
      onDrop: async (e: React.DragEvent<HTMLButtonElement>) => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = '';
        el.style.borderColor = '';
        const noteIdStr = e.dataTransfer.getData('id') || '';
        const noteId = parseInt(noteIdStr);
        
        if (!isNaN(noteId)) {
          const note = notes.find(n => n.id === noteId);
          if (note) {
            try {
              await api.updateNote(note.id, note.title, note.content, categoryId);
              showToast('笔记分类更新成功', 'success');
              await onNotesUpdated();
              if (noteId === selectedNoteId) {
                onSelectCategory(categoryId);
              }
            } catch (error) {
              showToast('更新笔记分类失败', 'error');
            }
          }
        }
      },
    };
  };

  return (
    <div className="h-full sidebar-bg border-r border-slate-200/80 flex flex-col overflow-hidden">
      {/* Logo */}
      <div className="p-4 pb-3 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-gradient-to-br from-primary-500 to-primary-700 rounded-lg flex items-center justify-center shadow-sm">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-bold text-slate-800 leading-none">FastNote</h1>
            <p className="text-[10px] text-slate-400 mt-0.5">简洁高效</p>
          </div>
        </div>
      </div>

      {/* 全部笔记 */}
      <div className="px-3 pb-2 flex-shrink-0">
        <button
          onClick={() => onSelectCategory(null)}
          className={`w-full text-left px-3 py-2 rounded-xl transition-all duration-200 flex items-center justify-between group ${
            selectedCategoryId === null
              ? 'bg-gradient-to-r from-primary-500 to-primary-600 text-white shadow-md shadow-primary-500/25'
              : 'hover:bg-white/80 text-slate-600 hover:text-slate-900'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <svg className={`w-4 h-4 ${selectedCategoryId === null ? 'text-white/90' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            <span className="text-sm font-medium">全部笔记</span>
          </div>
          <span className={`badge text-[10px] ${
            selectedCategoryId === null
              ? 'bg-white/20 text-white'
              : 'bg-slate-100 text-slate-500'
          }`}>
            {allNotesCount}
          </span>
        </button>
      </div>

      {/* 分类标题 */}
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        <div className="flex items-center justify-between px-4 py-2">
          <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">分类</h2>
          <button
            onClick={onCreateCategory}
            className="w-6 h-6 flex items-center justify-center rounded-lg hover:bg-white/80 text-slate-400 hover:text-primary-500 transition-all duration-200"
            title="创建分类"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3 min-h-0">
          <div className="space-y-0.5">
            {categories.length === 0 && (
              <div className="px-3 py-6 text-center">
                <svg className="w-8 h-8 text-slate-200 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <p className="text-xs text-slate-400">暂无分类</p>
                <p className="text-[10px] text-slate-300 mt-0.5">点击 + 创建</p>
              </div>
            )}
            {categories.map((category) => (
              <div
                key={category.id}
                className="group relative"
                onMouseEnter={() => setHoveredCategoryId(category.id)}
                onMouseLeave={() => setHoveredCategoryId(null)}
                onContextMenu={(e) => {
                  setContextMenuCategory(category);
                  handleContextMenu(e);
                }}
              >
                <div className="flex items-center w-full overflow-hidden">
                  <button
                    onClick={() => onSelectCategory(category.id)}
                    className={`flex-1 text-left px-3 py-2 rounded-xl transition-all duration-200 flex items-center gap-2.5 overflow-hidden min-w-0 border border-transparent ${
                      selectedCategoryId === category.id
                        ? 'bg-gradient-to-r from-primary-500 to-primary-600 text-white shadow-md shadow-primary-500/25'
                        : 'hover:bg-white/80 text-slate-600 hover:text-slate-900 hover:border-slate-200/50'
                    }`}
                    {...createDragHandle(category.id)}
                  >
                    <svg className={`w-4 h-4 flex-shrink-0 ${selectedCategoryId === category.id ? 'text-white/80' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                    <span className="text-sm flex-1 overflow-hidden text-ellipsis whitespace-nowrap min-w-0 font-medium">{category.name}</span>
                    <span className={`badge text-[10px] flex-shrink-0 ${
                      selectedCategoryId === category.id
                        ? 'bg-white/20 text-white'
                        : 'bg-slate-100 text-slate-500'
                    }`}>
                      {category.note_count}
                    </span>
                  </button>
                  <div
                    className={`absolute right-0 top-0 bottom-0 flex items-center pr-1 transition-opacity duration-200 ${
                      hoveredCategoryId === category.id ? 'opacity-100' : 'opacity-0'
                    }`}
                  >
                    <div className={`rounded-lg flex items-center gap-0.5 ${
                      selectedCategoryId === category.id ? 'bg-primary-700/50' : 'bg-white shadow-sm border border-slate-200/80'
                    }`}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onEditCategory(category);
                        }}
                        className="p-1 rounded-md transition-colors hover:bg-white/20"
                        title="编辑分类"
                      >
                        <svg className={`w-3.5 h-3.5 ${selectedCategoryId === category.id ? 'text-white/80' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteCategory(category);
                        }}
                        className="p-1 rounded-md transition-colors hover:bg-red-100"
                        title="删除分类"
                      >
                        <svg className={`w-3.5 h-3.5 ${selectedCategoryId === category.id ? 'text-red-300' : 'text-red-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 底部统计 */}
      <div className="px-4 py-3 border-t border-slate-200/60 flex-shrink-0">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>{categories.length} 个分类</span>
          <span>{allNotesCount} 篇笔记</span>
        </div>
      </div>

      {/* 分类右键菜单 */}
      <ContextMenu
        items={contextMenuCategory ? getCategoryMenuItems(contextMenuCategory) : []}
        position={menuPos}
        onClose={closeMenu}
      />
    </div>
  );
};
