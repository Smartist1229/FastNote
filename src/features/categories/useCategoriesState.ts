/**
 * 分组域：分组列表、抽屉展开状态、当前选中的分组（新建笔记的归属），
 * 以及新建 / 重命名 / 删除分组的弹窗状态与操作。
 *
 * loadData 由 notes 域提供，通过 ref 调用，避免两个域互相 import。
 */
import { logAction } from "@/lib/app/actionLog";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Category } from "@/interface/note/note";
import type { EncryptionScope } from "@/interface/system/encryption";
import type { AiAccessLevel } from "@/interface/ai/aiAccess";
import { AI_ACCESS_LABELS } from "@/interface/ai/aiAccess";
import * as categoriesApi from "@/api/note/categories";
import { useI18n } from "@/i18n";
import { isBackendError } from "@/lib/app/backendError";
import { errorText } from "@/lib/app/errorText";
import { useToast } from "@/components/common/Toast";

export interface UseCategoriesStateParams {
  /** 统一刷新（notes 域提供） */
  loadDataRef: { current: () => Promise<void> };
  requestUnlockRef: { current: (scope: EncryptionScope, id: string, permanent?: boolean) => void };
  lockOnceUnlockedRef: { current: (scope: EncryptionScope, id: string, clearSelected?: boolean) => void };
  /** 新建分组时套用的 AI 档位（来自 AI 设置） */
  defaultCategoryAiAccess: AiAccessLevel;
}

export function useCategoriesState({
  loadDataRef,
  requestUnlockRef,
  lockOnceUnlockedRef,
  defaultCategoryAiAccess,
}: UseCategoriesStateParams) {
  const { t } = useI18n();
  const { showToast } = useToast();

  /** 分组列表：loadData 统一刷新，AI 侧改库后依靠事件重新拉取 */
  const [categories, setCategories] = useState<Category[]>([]);
  /** 分组列表的镜像 ref：拖拽回调里拿分组名做确认提示，避免频繁重注册监听 */
  const categoriesRef = useRef<Category[]>([]);
  /** 新建笔记的默认归属分组：null 表示未分类（「全部」视图同样落到未分类） */
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  /** 抽屉展开状态：'all' | 分组ID | 'uncategorized' | null（全部收起） */
  const [expandedDrawer, setExpandedDrawer] = useState<string | 'all' | 'uncategorized' | null>(null);
  /** 分组新建/编辑共用弹窗：editingCategory 为 null 即新建 */
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [showDeleteCategoryModal, setShowDeleteCategoryModal] = useState(false);
  const [deletingCategory, setDeletingCategory] = useState<Category | null>(null);
  const [deleteCategoryNotes, setDeleteCategoryNotes] = useState(false);

  useEffect(() => { categoriesRef.current = categories; }, [categories]);

  /** 打开新建分组弹窗：清空编辑态与输入值 */
  const handleCreateCategory = () => {
    setEditingCategory(null);
    setCategoryName("");
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
      if (editingCategory) { await categoriesApi.updateCategory(editingCategory.id, categoryName); }
      else { await categoriesApi.createCategory(categoryName, defaultCategoryAiAccess); }
      await loadDataRef.current();
      setShowCategoryModal(false);
    } catch (error) {
      console.error("Failed to save category:", error);
    }
  };

  /** 命令面板的 create_category <名称>：直接建分组；名称为空时退回新建弹窗 */
  const handleCreateCategoryNamed = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      handleCreateCategory();
      return;
    }
    try {
      await categoriesApi.createCategory(trimmed, defaultCategoryAiAccess);
      logAction("group.create", trimmed);
      await loadDataRef.current();
      showToast(t("已创建分组「{name}」", { name: trimmed }), "success");
    } catch (error) {
      showToast(t("创建分组失败：{error}", { error: errorText(error) }), "error");
    }
  };

  const handleDeleteCategory = (category: Category) => {
    setDeletingCategory(category);
    /*
     * 加密分组只能连组内笔记一起删：组密钥一删，留下的密文永久解不开。
     * 这里默认勾上，弹窗里也把勾选锁死（不允许改成「只删分组」）。
     */
    setDeleteCategoryNotes(!!category.is_encrypted);
    setShowDeleteCategoryModal(true);
  };

  /** 重命名分组（属性弹窗内联编辑调用） */
  const handleRenameCategory = async (category: Category, name: string) => {
    try {
      await categoriesApi.updateCategory(category.id, name);
      logAction("group.rename", name);
      await loadDataRef.current();
      showToast(t("已更新分组名称"), "success");
    } catch {
      showToast(t("更新失败"), "error");
    }
  };

  /** 设置分组的 AI 访问档位：作为组内笔记的上限，但不改写笔记自身的档位 */
  const handleSetCategoryAiAccess = async (category: Category, level: AiAccessLevel) => {
    if (category.ai_access === level) return;
    try {
      await categoriesApi.setCategoryAiAccess(category.id, level);
      logAction("group.ai_access", `${category.name} -> ${level}`);
      setCategories((prev) => prev.map((c) => (c.id === category.id ? { ...c, ai_access: level } : c)));
      showToast(t("「{name}」的 AI 访问已设为{level}", {
        name: category.name, level: t(AI_ACCESS_LABELS[level]),
      }), "success");
    } catch {
      showToast(t("操作失败，请重试"), "error");
    }
  };

  /**
   * 确认删除分组：deleteCategoryNotes=true 时组内笔记一并移入回收站，
   * 否则由后端把这些笔记改为未分类；删的是当前分组时立刻取消选中。
   */
  const confirmDeleteCategory = async () => {
    if (!deletingCategory) return;
    try {
      await categoriesApi.deleteCategory(deletingCategory.id, deleteCategoryNotes);
      logAction("group.delete", deletingCategory?.name ?? "");
      if (selectedCategoryId === deletingCategory.id) { setSelectedCategoryId(null); }
      await loadDataRef.current();
      setShowDeleteCategoryModal(false);
      showToast(t("删除成功"), "success");
    } catch (error) {
      console.error("Failed to delete category:", error);
      // 加密分组不允许「只删分组」：后端会回带 code，转成人话
      const raw = errorText(error);
      showToast(
        isBackendError(error, "category_encrypted_keep")
          ? t("加密分组不能只删分组：请先「解密分组」，或在删除时选择同时删除组内笔记")
          : t("删除失败：{error}", { error: raw }),
        "error",
      );
    }
  };

  /** 展开/收起分组抽屉（点击同一分组可收起）；锁着的加密分组先走解锁 */
  const toggleDrawer = useCallback((key: string | 'all' | 'uncategorized') => {
    if (key !== 'all' && key !== 'uncategorized') {
      const category = categoriesRef.current.find((c) => c.id === key);
      // 锁定的加密分组要解锁才能「展开」；已经展开的允许直接收起，不必再输一次密码
      if (category?.is_encrypted && category.is_locked && expandedDrawer !== key) {
        void requestUnlockRef.current('category', key);
        return;
      }
      // 收起加密分组：顺手把「仅本次解锁」的组密钥锁回去
      if (category?.is_encrypted && expandedDrawer === key) {
        void lockOnceUnlockedRef.current('category', key, true);
      }
    }
    // 切到另一个分组时，把上一个分组的「仅本次解锁」锁回去
    if (expandedDrawer !== key && expandedDrawer !== null && expandedDrawer !== 'all' && expandedDrawer !== 'uncategorized') {
      const previous = categoriesRef.current.find((c) => c.id === expandedDrawer);
      if (previous?.is_encrypted) void lockOnceUnlockedRef.current('category', expandedDrawer, true);
    }
    setExpandedDrawer((current) => {
      const next = current === key ? null : key;
      // 'all' 是聚合视图，新建笔记时按"未分类"处理
      if (next !== null && next !== 'all' && next !== 'uncategorized') setSelectedCategoryId(next);
      else if (next === 'uncategorized' || next === 'all') setSelectedCategoryId(null);
      return next;
    });
  }, [expandedDrawer]);

  return {
    categories,
    setCategories,
    categoriesRef,
    selectedCategoryId,
    setSelectedCategoryId,
    expandedDrawer,
    setExpandedDrawer,
    showCategoryModal,
    setShowCategoryModal,
    editingCategory,
    categoryName,
    setCategoryName,
    showDeleteCategoryModal,
    setShowDeleteCategoryModal,
    deletingCategory,
    deleteCategoryNotes,
    setDeleteCategoryNotes,
    handleCreateCategory,
    handleEditCategory,
    handleSaveCategory,
    handleCreateCategoryNamed,
    handleDeleteCategory,
    handleRenameCategory,
    handleSetCategoryAiAccess,
    confirmDeleteCategory,
    toggleDrawer,
  };
}
