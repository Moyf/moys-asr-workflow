
// === 工具栏导出下拉菜单 ===




MaweExportMenus.bindToolbarExportDropdown('subtitle-export-dropdown', 'subtitle-export-btn', 'subtitle-export-menu');
MaweExportMenus.bindToolbarExportDropdown('gap-removed-export-dropdown', 'gap-removed-export-btn', 'gap-removed-export-menu');
MaweExportMenus.bindToolbarExportDropdown('extra-export-dropdown', 'extra-export-btn', 'extra-export-menu');
MaweExportMenus.bindToolbarExportDropdown('open-project-dropdown', 'open-project-menu-btn', 'open-project-menu');
MaweExportMenus.bindToolbarExportDropdown('save-project-dropdown', 'save-project-menu-btn', 'save-project-menu');
MaweExportMenus.bindToolbarExportDropdown('workspace-transfer-dropdown', 'workspace-transfer-btn', 'workspace-transfer-menu');
MaweExportMenus.bindToolbarExportDropdown('multi-subtitle-settings-dropdown', 'multi-subtitle-settings-toggle', 'multi-subtitle-settings-menu');
function positionDesktopPathMenu(buttonId, menuId) {
  const button = document.getElementById(buttonId);
  const menu = document.getElementById(menuId);
  if (!button || !menu) return;
  const buttonRect = button.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const margin = 8;
  const left = Math.max(margin, Math.min(buttonRect.left, window.innerWidth - menuRect.width - margin));
  const belowTop = buttonRect.bottom + 4;
  const top = belowTop + menuRect.height <= window.innerHeight - margin || buttonRect.top < menuRect.height + margin
    ? belowTop
    : Math.max(margin, buttonRect.top - menuRect.height - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}
MaweExportMenus.bindToolbarExportDropdown(
  'media-path-menu', 'media-path-menu-btn', 'media-path-menu-items',
  () => positionDesktopPathMenu('media-path-menu-btn', 'media-path-menu-items')
);
MaweExportMenus.bindToolbarExportDropdown(
  'project-path-menu', 'project-path-menu-btn', 'project-path-menu-items',
  () => positionDesktopPathMenu('project-path-menu-btn', 'project-path-menu-items')
);
MaweExportMenus.bindToolbarExportDropdown(
  'last-export-menu', 'last-export-summary', 'last-export-menu-items',
  () => positionDesktopPathMenu('last-export-summary', 'last-export-menu-items')
);

MaweExportMenus.bindToolbarExportDropdown(
  'batch-operations-dropdown', 'batch-operations-btn', 'batch-operations-menu',
  MaweExportMenus.positionBatchOperationsMenu,
);
