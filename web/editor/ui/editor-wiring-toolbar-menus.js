import { bindToolbarExportDropdown } from './editor-export-menus.js';

export function initMaweToolbarMenusWiring() {
// === 工具栏导出下拉菜单 ===




bindToolbarExportDropdown('subtitle-export-dropdown', 'subtitle-export-btn', 'subtitle-export-menu');
bindToolbarExportDropdown('gap-removed-export-dropdown', 'gap-removed-export-btn', 'gap-removed-export-menu');
bindToolbarExportDropdown('extra-export-dropdown', 'extra-export-btn', 'extra-export-menu');
bindToolbarExportDropdown('import-dropdown', 'import-btn', 'import-menu');
bindToolbarExportDropdown('save-project-dropdown', 'save-project-menu-btn', 'save-project-menu');
bindToolbarExportDropdown('workspace-transfer-dropdown', 'workspace-transfer-btn', 'workspace-transfer-menu');
}
