import { useState, useEffect, useCallback } from 'react';
import './App.css';
import { Note, Category } from './types';
import * as api from './api';
import { Sidebar } from './components/Sidebar';
import { NoteList } from './components/NoteList';
import { NoteEditor } from './components/NoteEditor';
import { Modal } from './components/Modal';
import { ToastProvider, useToast } from './components/Toast';
import { confirm } from '@tauri-apps/plugin-dialog';

function AppContent() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<string>('created_at');
  const [sortOrder, setSortOrder] = useState<string>('asc');
  const [searchQuery, setSearchQuery] = useState('');
  const [isNewNote, setIsNewNote] = useState<boolean>(false);
  
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [categoryName, setCategoryName] = useState('');
  
  const [showDeleteCategoryModal, setShowDeleteCategoryModal] = useState(false);
  const [deletingCategory, setDeletingCategory] = useState<Category | null>(null);
  const [deleteCategoryNotes, setDeleteCategoryNotes] = useState(false);

  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      if (import.meta.env.PROD) {
        e.preventDefault();
      }
    };
    document.addEventListener('contextmenu', handleContextMenu);
    return () => document.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  const filteredNotes = notes.filter((note) => {
    const matchesSearch = !searchQuery.trim() || 
      note.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      note.content.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = selectedCategoryId === null || note.category_id === selectedCategoryId;
    return matchesSearch && matchesCategory;
  });

  const loadData = useCallback(async () => {
    try {
      const [cats, notesList] = await Promise.all([
        api.getCategories(),
        api.getNotes(null, sortBy, sortOrder),
      ]);
      setCategories(cats);
      setNotes(notesList);
    } catch (error) {
      console.error('Failed to load data:', error);
    }
  }, [sortBy, sortOrder]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCreateNote = async () => {
    try {
      const newNote = await api.createNote('新笔记', '', selectedCategoryId);
      await loadData();
      setIsNewNote(true);
      setSelectedNote(newNote);
      setTimeout(() => setIsNewNote(false), 500);
    } catch (error) {
      console.error('Failed to create note:', error);
    }
  };

  const handleSaveNote = async (title: string, content: string, categoryId: number | null) => {
    if (!selectedNote) return;
    try {
      await api.updateNote(selectedNote.id, title, content, categoryId);
      const updatedNote = {
        ...selectedNote,
        title,
        content,
        category_id: categoryId,
        updated_at: new Date().toISOString(),
      };
      setSelectedNote(updatedNote);
      setNotes(prevNotes => 
        prevNotes.map(note => 
          note.id === selectedNote.id ? updatedNote : note
        )
      );
      if (selectedNote.category_id !== categoryId) {
        await loadData();
      }
    } catch (error) {
      console.error('Failed to save note:', error);
    }
  };

  const handleDeleteNote = async () => {
    if (!selectedNote) return;
    const confirmed = await confirm('确定要删除这条笔记吗？', '删除笔记');
    if (!confirmed) return;
    try {
      await api.deleteNotePermanently(selectedNote.id);
      await loadData();
      setSelectedNote(null);
      showToast('删除成功！', 'success');
    } catch (error) {
      console.error('Failed to delete note:', error);
      showToast('删除失败，请重试', 'error');
    }
  };

  const handleCreateCategory = () => {
    setEditingCategory(null);
    setCategoryName('');
    setShowCategoryModal(true);
  };

  const handleEditCategory = (category: Category) => {
    setEditingCategory(category);
    setCategoryName(category.name);
    setShowCategoryModal(true);
  };

  const handleSaveCategory = async () => {
    if (!categoryName.trim()) return;
    try {
      if (editingCategory) {
        await api.updateCategory(editingCategory.id, categoryName);
      } else {
        await api.createCategory(categoryName);
      }
      await loadData();
      setShowCategoryModal(false);
    } catch (error) {
      console.error('Failed to save category:', error);
    }
  };

  const handleDeleteCategory = (category: Category) => {
    setDeletingCategory(category);
    setDeleteCategoryNotes(false);
    setShowDeleteCategoryModal(true);
  };

  const confirmDeleteCategory = async () => {
    if (!deletingCategory) return;
    try {
      await api.deleteCategory(deletingCategory.id, deleteCategoryNotes);
      if (selectedCategoryId === deletingCategory.id) {
        setSelectedCategoryId(null);
      }
      await loadData();
      setShowDeleteCategoryModal(false);
    } catch (error) {
      console.error('Failed to delete category:', error);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-gray-50 min-w-0">
      <div className="md:hidden bg-gray-800 text-white p-3 flex items-center justify-between flex-shrink-0">
        <button onClick={() => setMobileSidebarOpen(!mobileSidebarOpen)} className="p-1.5">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <h1 className="text-lg font-bold">FastNote</h1>
        <div className="w-8"></div>
      </div>

      <div className="flex flex-1 overflow-hidden min-w-0">
        <div className={`${mobileSidebarOpen ? 'fixed inset-0 z-40' : 'hidden'} md:relative md:block md:w-56 md:flex-shrink-0 md:h-full`}>
          {mobileSidebarOpen && (
            <div className="absolute inset-0 bg-black bg-opacity-50" onClick={() => setMobileSidebarOpen(false)} />
          )}
          <div className={`${mobileSidebarOpen ? 'relative z-50 w-56 h-full' : 'h-full'}`}>
            <Sidebar
              categories={categories}
              notes={notes}
              selectedCategoryId={selectedCategoryId}
              onSelectCategory={(id) => {
                setSelectedCategoryId(id);
                setSelectedNote(null);
                setMobileSidebarOpen(false);
              }}
              onCreateCategory={handleCreateCategory}
              onEditCategory={handleEditCategory}
              onDeleteCategory={handleDeleteCategory}
            />
          </div>
        </div>

        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <div className="flex flex-1 overflow-hidden min-w-0">
            <div className="w-64 md:w-60 lg:w-72 border-r border-gray-200 bg-white flex flex-col flex-shrink-0">
              <div className="p-3 border-b border-gray-200 flex flex-col gap-2 flex-shrink-0">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-600">排序:</label>
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value)}
                      className="text-xs border border-gray-300 rounded-md px-2 py-1"
                    >
                      <option value="updated_at">更新时间</option>
                      <option value="created_at">创建时间</option>
                      <option value="title">标题</option>
                    </select>
                    <button
                      onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                      className="p-1 border border-gray-300 rounded-md hover:bg-gray-100 transition-colors"
                      title={sortOrder === 'asc' ? '切换为降序' : '切换为升序'}
                    >
                      <svg 
                        className={`w-3.5 h-3.5 text-gray-600 transition-transform ${sortOrder === 'desc' ? 'rotate-180' : ''}`}
                        fill="none" 
                        stroke="currentColor" 
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                      </svg>
                    </button>
                  </div>
                  <button
                    onClick={handleCreateNote}
                    className="p-1.5 bg-gray-800 text-white rounded-lg hover:bg-gray-700 transition-colors shadow-sm"
                    title="创建笔记"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    <input
                      type="text"
                      placeholder="搜索笔记..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-500 focus:border-transparent"
                    />
                  </div>
                  <button
                    onClick={() => window.location.reload()}
                    className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
                    title="刷新页面"
                  >
                    <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                </div>
              </div>
              <NoteList
                notes={filteredNotes}
                onSelectNote={(note) => {
                  setSelectedNote(note);
                  setIsNewNote(false);
                }}
                selectedNoteId={selectedNote?.id || null}
                sortOrder={sortOrder}
                isNewNote={isNewNote}
              />
            </div>
            <div className="flex-1 bg-white min-w-0">
              <NoteEditor
                note={selectedNote}
                categories={categories}
                onSave={handleSaveNote}
                onDelete={handleDeleteNote}
              />
            </div>
          </div>
        </div>
      </div>

      <Modal
        isOpen={showCategoryModal}
        onClose={() => setShowCategoryModal(false)}
        title={editingCategory ? '编辑分类' : '创建分类'}
      >
        <div className="space-y-3">
          <input
            type="text"
            value={categoryName}
            onChange={(e) => setCategoryName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleSaveCategory();
              }
            }}
            placeholder="分类名称"
            autoFocus
            className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:border-transparent text-sm"
          />
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setShowCategoryModal(false)}
              className="px-3 py-1.5 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors text-sm"
            >
              取消
            </button>
            <button
              onClick={handleSaveCategory}
              className="px-3 py-1.5 bg-gray-800 text-white rounded-lg hover:bg-gray-700 transition-colors shadow-sm text-sm"
            >
              保存
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showDeleteCategoryModal}
        onClose={() => setShowDeleteCategoryModal(false)}
        title="删除分类"
      >
        <div 
          className="space-y-3"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              confirmDeleteCategory();
            }
          }}
        >
          <p className="text-gray-600 text-sm">
            确定要删除分类 "{deletingCategory?.name}" 吗？
          </p>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="deleteNotes"
              checked={deleteCategoryNotes}
              onChange={(e) => setDeleteCategoryNotes(e.target.checked)}
              className="w-3.5 h-3.5"
            />
            <label htmlFor="deleteNotes" className="text-xs text-gray-600">
              同时删除该分类下的所有笔记
            </label>
          </div>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setShowDeleteCategoryModal(false)}
              className="px-3 py-1.5 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors text-sm"
            >
              取消
            </button>
            <button
              onClick={confirmDeleteCategory}
              className="px-3 py-1.5 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors shadow-sm text-sm"
            >
              删除
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}

export default App;
