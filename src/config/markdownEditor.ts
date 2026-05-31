import type { ToolbarNames, Themes } from 'md-editor-rt';

export const markdownEditorConfig = {
  toolbarsExclude: ['github','save'] as ToolbarNames[],
  theme: 'light' as Themes,
  previewTheme: 'default',
  codeTheme: 'atom',
  showCodeRowNumber: true,
  preview: false,
};
