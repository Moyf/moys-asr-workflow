// vm 切片测试的 window→全局转发：classic 体里裸名与 window.X 同源。
export function exposeWindowGlobals(context) {
  const win = context?.window;
  if (win && win !== context) {
    for (const [key, value] of Object.entries(win)) {
      if (!(key in context)) context[key] = value;
    }
  }
  return context;
}
