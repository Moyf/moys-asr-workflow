// 类型门修复批（仅 A 段）：自动扫描全部挂载门面，生成
// editor-facades.generated.d.ts（手工 d.ts 已声明真实契约的不重复
// 生成，TS2451 预防）。
//
// 历史段（已退役，教训保留）：
// B) 「函数声明 setter 摘除」曾在转换后对产物二次编辑，但它的
//    顶层 AST 扫描根本看不到生成器内部的函数声明——PR2 收尾时
//    这一步实际靠逐文件手工补丁完成，导致 12 个文件不可重放。
//    现规则已内化进 full-convert.mjs（函数声明只发布 getter，配
//    写点检查硬失败），产物可从 PR1 基线逐字节重放
//    （scripts/esm-mechanical/replay-verify.mjs）。
// C) 对象字面量重复键去重：跨对象 merge 链使静态去重改变运行时
//    值（实测 editor-i18n 词典），已回退；TS1117 计入类型基线。

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const webDir = path.join(root, 'web');
const walkFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walkFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const sources = walkFiles(webDir).filter((f) => f.endsWith('.js')
  && !f.includes('boot/launcher') && !f.includes(`${path.sep}launcher${path.sep}`)
  && !f.endsWith('editor-bundle.js') && !f.endsWith('launcher-bundle.js') && !f.endsWith('tooltip-bundle.js'));

// ---- A) facade 自动声明 ----
const manual = fs.readFileSync(path.join(webDir, 'editor/boot/editor-globals.d.ts'), 'utf8');
const manualDeclared = new Set([...manual.matchAll(/declare (?:const|var|let) (\w+)/g)].map((m) => m[1]));
const mountNames = new Set();
for (const file of sources) {
  const source = fs.readFileSync(file, 'utf8');
  for (const m of source.matchAll(/(?:^|[^.\w])(?:global|window|globalThis)\.(Mawe\w+|MAWE_I18N|Asr[A-Z]\w+|MAWEditor\w+|ASS_STYLE_LIBRARY|MULTI_SUBTITLE_UTILS|EDITOR_SETTINGS_UTILS)\s*=/gm)) {
    mountNames.add(m[1]);
  }
}
const autoNames = [...mountNames].filter((n) => !manualDeclared.has(n)).sort();
const outPath = path.join(webDir, 'editor/boot/editor-facades.generated.d.ts');
const header = `// 自动生成：scripts/esm-mechanical/typecheck-fixups.mjs（A 段）
// 全量 ESM 迁移后的挂载门面全局声明。真实契约逐步提升到
// editor-globals.d.ts（手工维护），此处仅消除「隐式全局」类型噪音。
// 修改挂载面后重跑本脚本。
`;
fs.writeFileSync(outPath, header
  + autoNames.map((n) => `declare var ${n}: any;`).join('\n') + '\n', 'utf8');
console.log(`A) auto facade declares: ${autoNames.length} (manual kept: ${[...mountNames].filter((n) => manualDeclared.has(n)).length})`);
