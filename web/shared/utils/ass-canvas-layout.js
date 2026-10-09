// ass-canvas-layout: ASS Canvas 预览的纯布局计算。
// 只做数值计算，不触碰 DOM 与 Canvas：文本测量通过注入的 measurer 完成，
// Node 测试可以用假测量器离线验证行切分、锚点与块偏移的正确性。
window.MAWE.register('utils-ass-canvas-layout', function createUtilsModule() {
  'use strict';

  const ASS_DEFAULT_PLAY_RES_X = 1920;
  const ASS_DEFAULT_PLAY_RES_Y = 1080;


  // ASS Alignment（数字小键盘布局 1-9）→ 网格坐标。column: 0 左 / 1 中 / 2 右；
  // row 采用屏幕语义：0 上 / 1 中 / 2 下（ASS 1-3 是底行，7-9 是顶行）。
  function assCanvasAlignmentGrid(value) {
    const alignment = Math.min(9, Math.max(1, Math.round(Number(value) || 2)));
    return { column: (alignment - 1) % 3, row: 2 - Math.floor((alignment - 1) / 3) };
  }


  // 事件锚点（PlayRes 原生坐标）：ASS 按对齐方式把文本块的对应边/中心
  // 贴到锚点上。有 \pos/\move 时，锚点就是移动后的绝对坐标——\pos 的
  // 语义正是「事件的锚点落在该坐标」，与边距无关。
  /**
   * @param {{
   *   alignment?: number,
   *   margins?: { left?: number, right?: number, vertical?: number },
   *   playResX?: number,
   *   playResY?: number,
   *   move?: { x?: number, y?: number } | null,
   * }} [options]
   */
  function assCanvasAnchorPoint({ alignment, margins, playResX, playResY, move } = {}) {
    if (move && Number.isFinite(Number(move.x)) && Number.isFinite(Number(move.y))) {
      return { x: Number(move.x), y: Number(move.y) };
    }
    const { column, row } = assCanvasAlignmentGrid(alignment);
    const left = Math.max(0, Number(margins?.left) || 0);
    const right = Math.max(0, Number(margins?.right) || 0);
    const vertical = Math.max(0, Number(margins?.vertical) || 0);
    const width = Math.max(1, Number(playResX) || ASS_DEFAULT_PLAY_RES_X);
    const height = Math.max(1, Number(playResY) || ASS_DEFAULT_PLAY_RES_Y);
    return {
      x: column === 0 ? left : column === 1 ? width / 2 : width - right,
      y: row === 0 ? vertical : row === 1 ? height / 2 : height - vertical,
    };
  }


  // 单行 x 偏移（相对锚点，绘制时再叠加块的行序号）：左列贴左、中列逐行
  // 居中、右列贴右——与 DOM 预览的 text-align 语义一致。
  function assCanvasLineOffsetX(column, lineWidth) {
    if (column === 1) return -lineWidth / 2;
    return column === 2 ? -lineWidth : 0;
  }


  // 块顶相对锚点的 y 偏移：底行块的底边贴锚点、中行居中、顶行顶边贴锚点。
  function assCanvasBlockTopY(row, blockHeight) {
    if (row === 1) return -blockHeight / 2;
    return row === 2 ? -blockHeight : 0;
  }


  // 把带样式的 run 序列按换行切成行并计算行内 x 偏移。
  // 工程文本中的真实换行就是 ASS 的 \N；run 顺序即阅读顺序。
  // measurer(run, fragment) 由绘制层注入（run 内不同字号/间距宽度不同），
  // 返回 { width, ascent, descent }；行高取行内所有 run 的最大 ascent/descent，
  // 与 CSS line-height: normal 的行盒语义一致。
  // 非空文本中的显式空行（\N\n）按基准 run 的行盒占一行高，与 libass 和
  // 旧 DOM 预览一致；整条文本为空时仍返回单个 0 高行，绘制层直接跳过。
  function assCanvasLayoutLines(runs, measurer) {
    const source = Array.isArray(runs) ? runs : [];
    const hasText = source.some((run) => String(run?.text ?? '').length > 0);
    const lines = [];
    let current = null;
    const pushLine = () => {
      current = { items: [], width: 0, ascent: 0, descent: 0 };
      lines.push(current);
    };
    pushLine();
    source.forEach((run) => {
      String(run?.text ?? '').split('\n').forEach((fragment, index) => {
        if (index > 0) pushLine();
        if (!fragment) return;
        const metrics = measurer ? measurer(run, fragment) : {};
        const width = Math.max(0, Number(metrics?.width) || 0);
        const ascent = Math.max(0, Number(metrics?.ascent) || 0);
        const descent = Math.max(0, Number(metrics?.descent) || 0);
        current.items.push({ run, text: fragment, x: current.width, width, ascent, descent });
        current.width += width;
        current.ascent = Math.max(current.ascent, ascent);
        current.descent = Math.max(current.descent, descent);
      });
    });
    if (hasText) {
      const probeRun = source.find((run) => String(run?.text ?? '').length > 0) || source[0];
      const blank = measurer ? measurer(probeRun, ' ') : {};
      lines.forEach((line) => {
        if (!line.items.length) {
          line.ascent = Math.max(0, Number(blank?.ascent) || 0);
          line.descent = Math.max(0, Number(blank?.descent) || 0);
        }
      });
    }
    let blockWidth = 0;
    let blockHeight = 0;
    lines.forEach((line) => {
      blockWidth = Math.max(blockWidth, line.width);
      blockHeight += line.ascent + line.descent;
    });
    return { lines, blockWidth, blockHeight };
  }


  return Object.freeze({
    assCanvasAlignmentGrid,
    assCanvasAnchorPoint,
    assCanvasBlockTopY,
    assCanvasLineOffsetX,
    assCanvasLayoutLines,
  });
});
