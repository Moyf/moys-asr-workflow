// 从 reviewed JSON 生成 old->new 替换对，并扫描各文件命中情况。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const reviewed = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'maw-copy-review-data.reviewed.json'), 'utf8'));

const pairs = []; // {from, to, rowId}
function addPair(from, to, rowId) {
  from = (from || '').trim(); to = (to || '').trim();
  if (!from || from === to) return;
  pairs.push({ from, to, rowId });
}
// 处理 "A（a / b）" 形式：括号内外分别对齐
function splitCompound(s) {
  // 顶层按「 / 」切分（不动括号内的，先整体试）
  return s.split(' / ');
}
for (const sec of reviewed.sections) {
  for (const row of sec.rows) {
    if (!row.final || row.final === row.orig) continue;
    const o = row.orig, f = row.final;
    // 括号复合：「标题（opt1 / opt2）」→ 拆括号
    const om = o.match(/^([^（）]+)（(.+)）$/), fm = f.match(/^([^（）]+)（(.+)）$/);
    if (om && fm) {
      addPair(om[1], fm[1], row.id);
      const os = om[2].split(' / '), fs2 = fm[2].split(' / ');
      if (os.length === fs2.length) os.forEach((x, i) => addPair(x, fs2[i], row.id));
      else addPair(om[2], fm[2], row.id);
      continue;
    }
    const os = splitCompound(o), fs2 = splitCompound(f);
    if (os.length > 1 && os.length === fs2.length) {
      os.forEach((x, i) => addPair(x, fs2[i], row.id));
    } else {
      addPair(o, f, row.id);
    }
  }
}

// 去重（同 from 取第一个，打印冲突）
const seen = new Map();
for (const p of pairs) {
  if (seen.has(p.from) && seen.get(p.from).to !== p.to) {
    console.log('!! 冲突:', p.from, '=>', seen.get(p.from).to, '/', p.to, `(${seen.get(p.from).rowId} vs ${p.rowId})`);
  } else if (!seen.has(p.from)) seen.set(p.from, p);
}
const uniq = [...seen.values()];
console.log('替换对总数:', uniq.length);

const FILES = [];
function walk(dir, filter) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (!['node_modules', '.git', '.codegraph'].includes(name)) walk(p, filter); }
    else if (filter(p)) FILES.push(p);
  }
}
walk(path.join(ROOT, 'web'), p => /\.(html|js)$/.test(p));
walk(path.join(ROOT, 'tests'), p => /\.(py|mjs|js)$/.test(p));
walk(path.join(ROOT, 'docs'), p => /\.md$/.test(p));
FILES.push(path.join(ROOT, 'CHANGELOG.md'));

const hits = [];
for (const p of uniq) {
  const files = [];
  for (const file of FILES) {
    const content = fs.readFileSync(file, 'utf8');
    const count = content.split(p.from).length - 1;
    if (count > 0) files.push(path.relative(ROOT, file) + (count > 1 ? `(x${count})` : ''));
  }
  hits.push({ from: p.from, to: p.to, rowId: p.rowId, files });
}
// 输出：未命中的 + 命中清单
console.log('\n=== 未命中任何文件的（需人工核对） ===');
for (const h of hits.filter(h => h.files.length === 0)) console.log(h.rowId, '|', h.from, '=>', h.to);
console.log('\n=== 命中清单 ===');
for (const h of hits.filter(h => h.files.length > 0)) console.log(h.rowId, '|', h.from, '=>', h.to, '||', h.files.join(', '));
fs.writeFileSync(path.join(ROOT, 'tools', 'copy-review', 'change-map.json'), JSON.stringify(hits, null, 2), 'utf8');
console.log('\nchange-map.json 已写出');
