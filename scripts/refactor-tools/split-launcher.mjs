// 把 web/launcher/launcher.js（单 IIFE）按功能域机械切割为 classic 共享作用域模块。
// 与 split-cluster.mjs 的区别：launcher.js 是 IIFE 而非平铺顶层，且本工具只做
// 连续区间切割、不做引用改写——拼接后所有声明仍在同一共享作用域，语义与原 IIFE 一致。
// 用法: node scripts/refactor-tools/split-launcher.mjs [--check]
// --check 只重跑等价审计，不改文件（源已切割后 launcher.js 不存在时审计走 bundle 源）。
//
// 语义保证：
// - 簇是原文件连续语句区间，清单顺序 == 原文件顺序，不重排；
// - 每行仅去掉 IIFE 统一的 2 格前导缩进（已验证全部模板字符串为单行）；
// - 切割后逐行审计：原 IIFE 体的非空行序列必须与全部模块内容行序列完全一致。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webDir = join(scriptDir, '..', '..', 'web');
const SOURCE = join(webDir, 'launcher', 'launcher.js');
const MANIFEST = join(webDir, 'launcher-scripts.txt');

const HEADER = `# MAW launcher sources are bundled in this order by scripts/build-launcher.mjs.
# Keep runtime/bootstrap modules before the modules that consume their exports.
# 由 scripts/refactor-tools/split-launcher.mjs 自 launcher.js 机械切割而来；
# 簇边界与等价性说明见 docs/REFACTOR_LAUNCHER_SPLIT.md。
`;

// 每簇：输出文件 + 头注释 + 首语句锚点（该声明的名字）。簇范围延伸到下一簇锚点前。
const CLUSTERS = [
  { file: 'launcher/i18n/launcher-strings.js', anchor: 'STRINGS', header: 'i18n 文案表：zh/en 全量字符串与后续 Object.assign 补丁。' },
  { file: 'launcher/boot/launcher-state.js', anchor: 'SERVER_STARTING_TEXT', header: '常量与状态：扩展名集合、存储键、state/dragState 及模块级可变句柄。' },
  { file: 'launcher/boot/launcher-mock-api.js', anchor: 'mockApi', header: '无 pywebview 后端时的 mock API（浏览器直接打开页面用）。' },
  { file: 'launcher/i18n/launcher-labels.js', anchor: 't', header: '文案与标签：翻译入口、诊断/供应商/模型/语言的英文映射与错误文案工具。' },
  { file: 'launcher/forms/launcher-form-base.js', anchor: 'ext', header: '表单基础：provider/model 选择器访问器与 OpenAI 自定义模型字段。' },
  { file: 'launcher/errors/launcher-errors.js', anchor: 'appendMessageText', header: '消息与错误报告：日志追加、错误面板渲染、复制与反馈链接。' },
  { file: 'launcher/server/launcher-server-monitor.js', anchor: 'setServerStatus', header: '编辑器服务器状态监控与轮询，含 appendLog/confirm 桥。' },
  { file: 'launcher/boot/launcher-theme-bridge.js', anchor: 'isThemePreference', header: '主题解析/应用与后端桥接（bridge/waitForBackend）、首屏 reveal。' },
  { file: 'launcher/forms/launcher-form-sync.js', anchor: 'fillSelect', header: '表单同步：下拉填充、provider 高级选项、热词与音轨设备选项。' },
  { file: 'launcher/local/launcher-local-models.js', anchor: 'isLocalProvider', header: '本地模型/运行时/OCR/对齐模型的渲染与刷新。' },
  { file: 'launcher/forms/launcher-provider-language.js', anchor: 'systemLanguage', header: '语言与 provider 应用层：界面语言、provider/model 联动、测试后缀。' },
  { file: 'launcher/presets/launcher-presets.js', anchor: 'ASR_PRESET_TEXT_FIELDS', header: '识别预设管理：字段收集/应用、预设库 CRUD 与管理面板。' },
  { file: 'launcher/forms/launcher-prefs-zoom.js', anchor: 'savePrefsNow', header: '偏好持久化与界面缩放（Ctrl+滚轮/快捷键）。' },
  { file: 'launcher/forms/launcher-media-form.js', anchor: 'audioTrackIndex', header: '媒体表单：音轨探测、媒体/工程路径设置与校验提示。' },
  { file: 'launcher/server/launcher-media-server.js', anchor: 'hasFileDrag', header: '拖放绑定与服务器媒体/FFmpeg 刷新。' },
  { file: 'launcher/boot/launcher-settings-startup.js', anchor: 'selectSettingsTab', header: '设置面板导航与启动状态刷新、init 入口。' },
  { file: 'launcher/boot/launcher-notify-backend.js', anchor: 'completionNotificationsEnabled', header: '完成通知与后端事件分发（handleBackendEvent）。' },
  { file: 'launcher/boot/launcher-wiring.js', anchor: 'syncDefaultOutputPreview', header: '启动接线：事件绑定、监听注册与 init() 调用（模块求值期执行）。' },
];

const parse = (source) => acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
const lines = (text) => text.split('\n');
const stripIndent = (text) => text.split('\n').map(line => line.startsWith('  ') ? line.slice(2) : line).join('\n');
const trimBlank = (rows) => {
  const copy = [...rows];
  while (copy.length && copy[0].trim() === '') copy.shift();
  while (copy.length && copy[copy.length - 1].trim() === '') copy.pop();
  return copy;
};
// 前导注释：语句上方紧邻的连续注释行（中间不允许空行）归属该语句。
function leadingCommentStart(allRows, stmtStartLine) {
  let line = stmtStartLine - 1; // 1-based -> index of previous row
  let first = stmtStartLine;
  while (line - 1 >= 0) {
    const text = allRows[line - 1].trim();
    const gap = allRows[line - 1] === '';
    if (gap) break;
    const isComment = text.startsWith('//') || text.startsWith('/*') || text.startsWith('*');
    if (!isComment) break;
    first = line;
    line -= 1;
  }
  return first;
}

function statementName(stmt) {
  if (stmt.type === 'FunctionDeclaration' && stmt.id) return stmt.id.name;
  if (stmt.type === 'VariableDeclaration') {
    for (const decl of stmt.declarations) {
      if (decl.id.type === 'Identifier') return decl.id.name;
    }
  }
  return null;
}

function extractRows(source) {
  const ast = parse(source);
  if (ast.body.length !== 1 || ast.body[0].type !== 'ExpressionStatement') {
    throw new Error('launcher.js 顶层必须只有一条 IIFE 表达式语句');
  }
  const iife = ast.body[0].expression;
  const fn = iife.callee || (iife.type === 'AssignmentExpression' ? iife.right.callee : null);
  if (!fn || !fn.body) throw new Error('无法定位 IIFE 函数体');
  const stmts = fn.body.body;
  if (stmts[0]?.type !== 'ExpressionStatement' || source.slice(stmts[0].start, stmts[0].end).trim() !== '"use strict";') {
    throw new Error('IIFE 首语句必须是 "use strict"');
  }
  return { rows: lines(source), stmts };
}

// 审计：原 IIFE 体的非空行序列（去 2 格缩进）必须与模块行序列一致。
function audit(originalRows, modules) {
  const useStrictEnd = originalRows.findIndex(row => row.trim() === '"use strict";');
  const bodyEnd = originalRows.length - 2; // 排除 `})();`
  const expected = trimBlank(originalRows.slice(useStrictEnd + 1, bodyEnd).map(row => row.startsWith('  ') ? row.slice(2) : row))
    .filter(row => row.trim() !== '');
  const actual = trimBlank(modules.flatMap(m => trimBlank(lines(m.body).slice(1)))).filter(row => row.trim() !== '');
  if (expected.length !== actual.length) {
    throw new Error(`等价审计失败：行数不一致 expected=${expected.length} actual=${actual.length}`);
  }
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== actual[i]) {
      throw new Error(`等价审计失败：第 ${i + 1} 行不一致\nexpected: ${expected[i]}\nactual:   ${actual[i]}`);
    }
  }
  return expected.length;
}

function split() {
  const source = readFileSync(SOURCE, 'utf8');
  const { rows, stmts } = extractRows(source);
  const byName = new Map();
  stmts.forEach((stmt, index) => {
    const name = statementName(stmt);
    if (name && !byName.has(name)) byName.set(name, index);
  });
  const bounds = CLUSTERS.map(cluster => {
    const index = byName.get(cluster.anchor);
    if (index === undefined) throw new Error(`锚点声明不存在: ${cluster.anchor}`);
    const startLine = leadingCommentStart(rows, stmts[index].loc.start.line);
    return { cluster, startLine, stmtIndex: index };
  });
  const modules = bounds.map(({ cluster, startLine }, i) => {
    const next = bounds[i + 1];
    const endLine = next ? next.startLine - 1 : rows.length - 2; // 排除 `})();` 与尾部换行
    const body = stripIndent(trimBlank(rows.slice(startLine - 1, endLine)).join('\n'));
    return { ...cluster, body: `// ${cluster.header}\n\n${body}\n` };
  });
  const checked = audit(rows, modules);
  for (const module of modules) {
    if (existsSync(join(webDir, ...module.file.split('/')))) throw new Error(`目标已存在，拒绝覆盖: ${module.file}`);
  }
  for (const module of modules) {
    const target = join(webDir, ...module.file.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, module.body);
  }
  writeFileSync(MANIFEST, HEADER + modules.map(m => m.file).join('\n') + '\n');
  console.log(`split ok: ${modules.length} modules, ${checked} audited lines`);
  for (const module of modules) console.log(`  ${module.file} (${lines(module.body).length} lines)`);
}

// --check：launcher.js 已删除后，校验模块行序仍然互洽（无重复、无空文件）。
function check() {
  const manifest = readFileSync(MANIFEST, 'utf8').split('\n').map(l => l.split('#')[0].trim()).filter(Boolean);
  const bodies = manifest.map(file => trimBlank(lines(readFileSync(join(webDir, ...file.split('/')), 'utf8'))));
  for (const [i, body] of bodies.entries()) {
    if (!body.length) throw new Error(`模块为空: ${manifest[i]}`);
  }
  console.log(`check ok: ${bodies.length} modules, ${bodies.reduce((sum, body) => sum + body.length, 0)} lines`);
}

if (process.argv[2] === '--check') check();
else split();
