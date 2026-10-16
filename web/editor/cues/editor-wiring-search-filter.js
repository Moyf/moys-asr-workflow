
import { MaweSearch } from "./editor-search.js";

// 真 ESM：wiring 顶层接线（原转换体 phase-1/phase-2 = import 求值）。
'use strict';
import { MaweColorFilter } from "./editor-color-filter.js";
import { MaweExportMenus } from "../ui/editor-export-menus.js";
import { MaweDom } from "../ui/editor-dom.js";
MaweColorFilter.renderColorFilterMenu();

MaweExportMenus.bindToolbarExportDropdown(
  'color-filter-dropdown', 'color-filter-btn', 'color-filter-menu',
  MaweColorFilter.positionColorFilterMenu,
);

// === 搜索 ===




MaweDom.searchEl.addEventListener('input', () => {
  MaweSearch.refreshSearchClearVisibility();
  clearTimeout(MaweSearch.searchDebounce);
  MaweSearch.searchDebounce = setTimeout(() => MaweSearch.applySearch(MaweDom.searchEl.value), 100);
});
document.getElementById('search-clear')?.addEventListener('click', () => {
  MaweDom.searchEl.value = '';
  MaweSearch.refreshSearchClearVisibility();
  MaweSearch.applySearch('');
  MaweDom.searchEl.focus({ preventScroll: true });
});
