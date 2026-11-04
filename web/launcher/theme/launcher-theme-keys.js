// 主题常量与无状态主题判断（L02 叶子）。
// 只读纯数据/纯函数：不读 DOM、不读 state、不请求后端；
// localStorage 的读写留在 launcher-theme-bridge.js。
// 经 transition 机制注入 classic 作用域的导出是 createThemeKeys，
// classic 消费者在原位置调用一次得到 { THEME_KEY, isThemePreference }。
export function createThemeKeys() {
  const THEME_KEY = "MAW_GUI_THEME";
  function isThemePreference(value) {
    return value === "light" || value === "dark" || value === "system";
  }
  return { THEME_KEY, isThemePreference };
}
