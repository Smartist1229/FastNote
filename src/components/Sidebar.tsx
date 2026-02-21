import { useState } from 'react';
import { Category, Note } from '../types';

interface SidebarProps {
  categories: Category[];
  notes: Note[];
  selectedCategoryId: number | null;
  onSelectCategory: (id: number | null) => void;
  onCreateCategory: () => void;
  onEditCategory: (category: Category) => void;
  onDeleteCategory: (category: Category) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  categories,
  notes,
  selectedCategoryId,
  onSelectCategory,
  onCreateCategory,
  onEditCategory,
  onDeleteCategory,
}) => {
  const [hoveredCategoryId, setHoveredCategoryId] = useState<number | null>(null);

  return (
    <div className="h-full bg-gray-100 border-r border-gray-200 flex flex-col overflow-hidden">
      <div className="p-3 border-b border-gray-200 flex-shrink-0">
        <h1 className="text-lg font-bold text-gray-800">FastNote</h1>
      </div>

      <div className="p-2 border-b border-gray-200 flex-shrink-0">
        <button
          onClick={() => onSelectCategory(null)}
          className={`w-full text-left px-3 py-2 rounded-lg transition-colors flex items-center justify-between ${
            selectedCategoryId === null
              ? 'bg-gray-800 text-white'
              : 'hover:bg-gray-200 text-gray-700'
          }`}
        >
          <span className="text-sm">全部笔记</span>
          <span className="text-xs opacity-70">
            {notes.length}
          </span>
        </button>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        <div className="flex items-center justify-between p-2 pb-1 px-3">
          <h2 className="text-xs font-semibold text-gray-600">分类</h2>
          <button
            onClick={onCreateCategory}
            className="p-0.5 hover:bg-gray-200 rounded transition-colors"
            title="创建分类"
          >
            <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2 min-h-0 scrollbar-visible" style={{ scrollbarWidth: 'thin', scrollbarColor: '#9ca3af #f3f4f6' }}>
          <style>{`
            .scrollbar-visible::-webkit-scrollbar {
              width: 6px;
            }
            .scrollbar-visible::-webkit-scrollbar-track {
              background: #f3f4f6;
            }
            .scrollbar-visible::-webkit-scrollbar-thumb {
              background: #9ca3af;
              border-radius: 3px;
            }
            .scrollbar-visible::-webkit-scrollbar-thumb:hover {
              background: #6b7280;
            }
          `}</style>
          <div className="space-y-0.5">
            {categories.map((category) => (
              <div
                key={category.id}
                className="group relative"
                onMouseEnter={() => setHoveredCategoryId(category.id)}
                onMouseLeave={() => setHoveredCategoryId(null)}
              >
                <div className="flex items-center w-full overflow-hidden">
                  <button
                    onClick={() => onSelectCategory(category.id)}
                    className={`flex-1 text-left px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2 overflow-hidden min-w-0 ${
                      selectedCategoryId === category.id
                        ? 'bg-gray-800 text-white'
                        : 'hover:bg-gray-200 text-gray-700'
                    }`}
                  >
                    <span className="text-sm flex-1 overflow-hidden text-ellipsis whitespace-nowrap min-w-0">{category.name}</span>
                    <span className="text-xs opacity-70 flex-shrink-0 mr-12">{category.note_count}</span>
                  </button>
                  <div
                    className={`absolute right-0 top-0 bottom-0 flex items-center pr-1 transition-opacity duration-200 ${
                      hoveredCategoryId === category.id ? 'opacity-100' : 'opacity-0'
                    }`}
                  >
                    <div className={`rounded-lg flex items-center ${selectedCategoryId === category.id ? 'bg-gray-700' : 'bg-gray-200'}`}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onEditCategory(category);
                        }}
                        className={`p-1 rounded transition-colors ${selectedCategoryId === category.id ? 'hover:bg-gray-600' : 'hover:bg-gray-300'}`}
                        title="编辑分类"
                      >
                        <svg className={`w-3.5 h-3.5 ${selectedCategoryId === category.id ? 'text-gray-200' : 'text-gray-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteCategory(category);
                        }}
                        className={`p-1 rounded-r-lg transition-colors ${selectedCategoryId === category.id ? 'hover:bg-red-900/50' : 'hover:bg-red-100'}`}
                        title="删除分类"
                      >
                        <svg className={`w-3.5 h-3.5 ${selectedCategoryId === category.id ? 'text-red-300' : 'text-red-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
    </div>
  );
};
