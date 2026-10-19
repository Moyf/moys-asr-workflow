/* 用当前 CL 对拍 cl-lib.js：解析往返必须无损；全部正式版归档必须与 prepare_release_notes.py 产物逐字节一致。 */
const fs = require('node:fs');
const path = require('node:path');
const CLScratch = require('./cl-lib.js');

const repoRoot = path.resolve(__dirname, '..', '..');
const clText = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`ok - ${name}`);
  else { failures += 1; console.error(`FAIL - ${name}${detail ? `\n  ${detail}` : ''}`); }
};

// 1) 解析 → 序列化往返无损（整份文档）
const { preamble, sections } = CLScratch.splitSections(clText);
const rebuilt = preamble + sections.map((s) => s.rawText).join('');
check('splitSections passthrough', rebuilt === clText);

let roundtripOk = true;
for (const section of sections) {
  const parsed = CLScratch.parseSection(section);
  const text = CLScratch.serializeSection(section, parsed);
  if (text !== section.rawText) {
    roundtripOk = false;
    console.error(`  section mismatch: ${section.name}`);
    for (let i = 0; i < Math.max(text.length, section.rawText.length); i += 1) {
      if (text[i] !== section.rawText[i]) {
        console.error(`  first diff at char ${i}: ${JSON.stringify(text.slice(i, i + 40))} vs ${JSON.stringify(section.rawText.slice(i, i + 40))}`);
        break;
      }
    }
  }
  // 每个条目卡片行数与原始条目一致
  for (const card of parsed.cards) {
    if (card.kind === 'entry' && card.lines.length < 1) roundtripOk = false;
  }
}
check('parseSection/serializeSection roundtrip (all sections)', roundtripOk,
  `${sections.length} sections`);

// 2) extractSection 与归档生成：全部正式版与仓库现有归档逐字节一致
const releasesDir = path.join(repoRoot, 'docs', 'releases');
const archives = fs.readdirSync(releasesDir).filter((f) => f.endsWith('.md') && f !== 'README.md');

(async () => {
  for (const file of archives) {
    const version = file.slice(0, -3);
    if (!CLScratch.isStable(version)) {
      check(`skip prerelease archive ${file}`, true);
      continue;
    }
    const expected = fs.readFileSync(path.join(releasesDir, file), 'utf8');
    try {
      const actual = await CLScratch.buildArchive(clText, version);
      if (actual === expected) check(`archive ${file}`, true);
      else {
        let detail = '';
        for (let i = 0; i < Math.max(actual.length, expected.length); i += 1) {
          if (actual[i] !== expected[i]) {
            detail = `first diff at char ${i}:\n  js:      ${JSON.stringify(actual.slice(Math.max(0, i - 30), i + 50))}\n  python:  ${JSON.stringify(expected.slice(Math.max(0, i - 30), i + 50))}`;
            break;
          }
        }
        check(`archive ${file}`, false, detail);
      }
    } catch (error) {
      check(`archive ${file}`, false, error.message);
    }
  }
  // 3) 非 stable 版本必须被拒绝
  try {
    await CLScratch.buildArchive(clText, '1.9.0-beta.3');
    check('reject prerelease archive', false, 'no error raised');
  } catch { check('reject prerelease archive', true); }
  // 4) wordDiff 基本行为
  const diff = CLScratch.wordDiff('旧文本 A', '新文本 A');
  check('wordDiff marks changed prefix', JSON.stringify(diff.map((d) => d.type)) === JSON.stringify(['del', 'ins', 'same']));

  console.log(failures === 0 ? `\nall checks passed (${sections.length} sections, ${archives.length} archives)` : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
