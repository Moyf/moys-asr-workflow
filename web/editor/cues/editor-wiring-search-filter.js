import { MaweDom } from '../ui/editor-dom.js';
import { MaweSearch } from './editor-search.js';
import { bindToolbarExportDropdown } from '../ui/editor-export-menus.js';
import { renderColorFilterMenu, positionColorFilterMenu } from './editor-color-filter.js';

export function initMaweSearchFilterWiring() {
// === 颜色过滤 ===
// 工程中存在彩色字幕时，在过滤输入框右侧显示 🎨 按钮：
// 点击行（非 checkbox）= 只显示该颜色；勾选 checkbox = 多选；清除 = 全部显示。




 // null = 不过滤；Set<string> = 仅显示这些颜色键




// 双列 / 仅副轨显示模式下，列表行不携带颜色条：按钮隐藏且过滤暂停生效，
// 避免出现“看不到过滤开关但列表被过滤”的死角。只有单列主轨列表参与过滤。




























renderColorFilterMenu();

bindToolbarExportDropdown(
  'color-filter-dropdown', 'color-filter-btn', 'color-filter-menu',
  positionColorFilterMenu,
);

// === 搜索 ===




MaweDom.searchEl.addEventListener('input', () => {
  clearTimeout(MaweSearch.searchDebounce);
  MaweSearch.searchDebounce = setTimeout(() => MaweSearch.applySearch(MaweDom.searchEl.value), 100);
});

// === 编辑 ===
}
