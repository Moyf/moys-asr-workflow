/* CHANGELOG 编辑器核心逻辑。
 * 与 scripts/prepare_release_notes.py 保持契约一致：
 * - extractSection / buildArchive 与 extract_release_section / build_release_document 逐字节等价
 * - parseChangelog + serializeChangelog 对未编辑内容必须往返无损
 * 经典脚本（file:// 下 ES module 会被 CORS 拦截），浏览器挂 window.CLLib，Node 走 module.exports。 */
(function () {
  'use strict';

  const REPO = 'Moyf/moys-asr-workflow';
  const VERSION_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
  const BASE_MARK_RE = /^<!-- release-base: ([^\s]+) -->$/;
  const IMAGE_SUFFIX_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
  const HEAD_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

  function escapeReg(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function parseTag(version) {
    const tag = version.startsWith('v') ? version : 'v' + version;
    const match = VERSION_RE.exec(tag);
    if (!match) return null;
    if (match[4]) {
      for (const part of match[4].split('.')) {
        if (/^\d+$/.test(part) && part.length > 1 && part[0] === '0') return null;
      }
    }
    return match;
  }

  function isStable(version) {
    const match = parseTag(version);
    return Boolean(match) && !match[4];
  }

  /** Python re 的 (?ms)^## \[name\][^\n]*\n.*?(?=^## \[|\Z) 等价实现；要求恰好一处。 */
  function extractSection(changelog, version) {
    const text = String(changelog).replace(/\r\n/g, '\n');
    const pattern = new RegExp(
      '^## \\[' + escapeReg(version) + '\\][^\\n]*\\n[\\s\\S]*?(?=^## \\[|$(?![\\s\\S]))', 'gm');
    const matches = text.match(pattern);
    if (!matches || matches.length === 0) throw new Error(`CHANGELOG.md does not contain a release section for ${version}.`);
    if (matches.length !== 1) throw new Error(`duplicate CHANGELOG.md release section for ${version}.`);
    return matches[0].trim();
  }

  function normPosixPath(path) {
    if (path === '') return '.';
    const absolute = path.startsWith('/');
    const out = [];
    for (const part of path.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (out.length && out[out.length - 1] !== '..') out.pop();
        else if (!absolute) out.push('..');
      } else out.push(part);
    }
    let joined = out.join('/');
    if (absolute) joined = '/' + joined;
    return joined === '' ? (absolute ? '/' : '.') : joined;
  }

  function quotePath(path) {
    return path.split('/').map(encodeURIComponent).join('/');
  }

  /** pinned_link 的等价实现；target 为仓库相对路径时固定到 tag。 */
  function pinnedLink(target, tag, image) {
    if (HEAD_SCHEME_RE.test(target) || target.startsWith('//') || target.startsWith('#')) return target;
    let rest = target, query = '', fragment = '';
    const hashIdx = rest.indexOf('#');
    if (hashIdx >= 0) { fragment = rest.slice(hashIdx + 1); rest = rest.slice(0, hashIdx); }
    const qIdx = rest.indexOf('?');
    if (qIdx >= 0) { query = rest.slice(qIdx + 1); rest = rest.slice(0, qIdx); }
    let decoded;
    try { decoded = decodeURIComponent(rest); } catch { decoded = rest; }
    const path = normPosixPath(decoded.replace(/^\/+/, ''));
    if (path === '..' || path.startsWith('../') || path.includes('\\')) {
      throw new Error(`link outside the repository: ${target}`);
    }
    const isImage = image || IMAGE_SUFFIX_RE.test(path);
    const base = isImage
      ? `https://raw.githubusercontent.com/${REPO}/${tag}/`
      : `https://github.com/${REPO}/blob/${tag}/`;
    return base + quotePath(path) + (query ? '?' + query : '') + (fragment ? '#' + fragment : '');
  }

  /** pin_repo_links 等价实现：代码围栏与行内代码保持原样。 */
  function pinRepoLinks(markdown, tag) {
    const lines = [];
    let fence = null;
    for (const line of markdown.split('\n')) {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
        lines.push(line);
        continue;
      }
      if (marker) { fence = marker[1]; lines.push(line); continue; }
      const visible = line.replace(/(`+)[\s\S]*?\1/g, (m) => ' '.repeat(m.length));
      const replacements = [];
      let cursor = 0;
      for (;;) {
        const start = visible.indexOf('](', cursor);
        if (start < 0) break;
        let begin = start + 2;
        let end;
        if (begin < line.length && line[begin] === '<') {
          end = line.indexOf('>', begin + 1);
          if (end < 0) break;
          begin += 1;
          cursor = end + 1;
        } else {
          let depth = 1;
          end = begin;
          while (end < line.length) {
            const char = line[end];
            if (char === '\\') { end += 2; continue; }
            if (char === '(') depth += 1;
            else if (char === ')') { depth -= 1; if (depth === 0) break; }
            else if (/\s/.test(char) && depth === 1) break;
            end += 1;
          }
          cursor = Math.max(end + 1, begin + 1);
        }
        const image = /!\[[^\]]*$/.test(visible.slice(0, start));
        replacements.push([begin, end, pinnedLink(line.slice(begin, end), tag, image)]);
      }
      const definition = visible.match(/^ {0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/d);
      if (definition) {
        const groupIndex = definition[1] !== undefined ? 1 : 2;
        const dIndices = definition.indices;
        if (dIndices && dIndices[groupIndex]) {
          replacements.push([...dIndices[groupIndex], pinnedLink(definition[groupIndex], tag)]);
        }
      }
      for (const match of visible.matchAll(/\b(src|href)\s*=\s*["']([^"']+)["']/gid)) {
        replacements.push([match.indices[2][0], match.indices[2][1],
          pinnedLink(match[2], tag, match[1].toLowerCase() === 'src')]);
      }
      replacements.sort((a, b) => b[0] - a[0]);
      let result = line;
      for (const [begin, end, target] of replacements) {
        result = result.slice(0, begin) + target + result.slice(end);
      }
      lines.push(result);
    }
    return lines.join('\n');
  }

  async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const DOC_PREFIX = '<!-- maw-release ';

  /** build_release_document 等价实现；仅接受正式版。返回完整文档文本。 */
  async function buildArchive(changelog, version) {
    const parsed = parseTag(version);
    if (!parsed) throw new Error(`invalid release tag: v${version}`);
    if (parsed[4]) throw new Error(`v${version}: only stable versions can be archived in docs/releases`);
    const section = extractSection(changelog, version);
    const firstLine = section.split('\n')[0];
    const heading = firstLine.match(/^## \[[^\]]+\] - (\d{4}-\d{2}-\d{2})$/);
    if (!heading) throw new Error(`v${version}: release heading needs an ISO date: ## [${version}] - YYYY-MM-DD`);
    const iso = heading[1];
    if (Number.isNaN(Date.parse(iso + 'T00:00:00Z'))) throw new Error(`v${version}: invalid date ${iso}`);

    const sectionLines = section.split('\n');
    const bases = sectionLines.map((line) => {
      const found = BASE_MARK_RE.exec(line);
      return found ? found[1] : null;
    }).filter(Boolean);
    const leftoverBase = sectionLines.some((line) => line.includes('<!-- release-base:') && !BASE_MARK_RE.test(line));
    if (bases.length > 1 || leftoverBase) {
      throw new Error(`v${version}: expected at most one <!-- release-base: X.Y.0 --> marker`);
    }
    const base = bases[0] || null;
    if (base) {
      const baseParsed = parseTag(base);
      if (!baseParsed || baseParsed[4] || baseParsed[3] !== '0'
        || baseParsed[1] !== parsed[1] || baseParsed[2] !== parsed[2]
        || Number(parsed[3]) === 0) {
        throw new Error(`v${version}: base must be the stable X.Y.0 of the same patch series`);
      }
    }
    const sourceSha256 = await sha256Hex(section);
    // 与 Python json.dumps(..., sort_keys=True) 完全一致：键名字典序、", " / ": " 分隔、非 ASCII 不转义。
    const fields = [
      ['base', base], ['channel', 'stable'], ['date', iso],
      ['schema', 'maw.release.v1'], ['source_sha256', sourceSha256], ['version', version],
    ];
    const metadataJson = `{${fields.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(', ')}}`;
    let body = sectionLines.filter((line) => !BASE_MARK_RE.test(line)).join('\n');
    body = body.replace(/\n{3,}/g, '\n\n').trim();
    return `${DOC_PREFIX}${metadataJson} -->\n\n${pinRepoLinks(body, 'v' + version)}\n`;
  }

  function documentParts(documentText) {
    const sep = '\n\n';
    const sepIdx = documentText.indexOf(sep);
    const header = sepIdx >= 0 ? documentText.slice(0, sepIdx) : documentText;
    const body = sepIdx >= 0 ? documentText.slice(sepIdx + sep.length) : '';
    if (!header.startsWith(DOC_PREFIX) || !header.endsWith(' -->')) {
      throw new Error('invalid release document header');
    }
    return { metadata: JSON.parse(header.slice(DOC_PREFIX.length, -4)), body: body.trim() };
  }

  // ---------- CHANGELOG 结构化解析 / 序列化（往返无损） ----------

  function splitSections(changelog) {
    const text = String(changelog).replace(/\r\n/g, '\n');
    const headingRe = /^## \[([^\]]+)\]([^\n]*)$/gm;
    const found = [];
    for (const match of text.matchAll(headingRe)) {
      found.push({ name: match[1].trim(), suffix: match[2], index: match.index, end: match.index + match[0].length });
    }
    const preamble = found.length ? text.slice(0, found[0].index) : text;
    const sections = [];
    found.forEach((item, i) => {
      const rawStart = item.index;
      const rawEnd = i + 1 < found.length ? found[i + 1].index : text.length;
      const dateMatch = /^\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(item.suffix);
      sections.push({
        name: item.name,
        date: dateMatch ? dateMatch[1] : null,
        heading: `## [${item.name}]${item.suffix}`,
        rawText: text.slice(rawStart, rawEnd),
      });
    });
    return { preamble, sections };
  }

  /** 把一个版本小节解析成卡片。卡片 lines 为正文行；blanksBefore 保留原有空行数。
   *  条目卡片的 images 为统一图片列表：{kind:'existing', alt, path}（已在 CL 中）或 {kind:'new', id}（粘贴待写盘）。 */
  function parseSection(section) {
    const content = section.rawText.split('\n').slice(1); // 去掉标题行
    if (content.length && content[content.length - 1] === '') content.pop(); // 去掉结尾换行产生的空尾巴
    const cards = [];
    let blanks = 0;
    const pushCard = (card) => {
      card.blanksBefore = blanks;
      blanks = 0;
      cards.push(card);
    };
    for (const line of content) {
      if (line.trim() === '') { blanks += 1; continue; }
      if (line.startsWith('- ')) {
        pushCard({ kind: 'entry', lines: [line], images: [], original: line });
      } else if (/^!\[/.test(line) && blanks === 0 && cards.length && cards[cards.length - 1].kind === 'entry') {
        const altMatch = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line);
        if (altMatch) {
          cards[cards.length - 1].images.push({ kind: 'existing', alt: altMatch[1], path: altMatch[2] });
        } else {
          pushCard({ kind: 'text', lines: [line], original: line });
        }
      } else if (/^#+ /.test(line)) {
        pushCard({ kind: 'heading', lines: [line], original: line });
      } else {
        pushCard({ kind: 'text', lines: [line], original: line });
      }
    }
    return { cards, trailingBlanks: blanks };
  }

  function serializeSection(section, parsed) {
    const lines = [section.heading];
    for (const card of parsed.cards) {
      for (let i = 0; i < card.blanksBefore; i += 1) lines.push('');
      if (card.kind === 'entry') lines.push(...entryCardToLines(card));
      else lines.push(...card.lines);
    }
    for (let i = 0; i < parsed.trailingBlanks; i += 1) lines.push('');
    return lines.join('\n') + '\n';
  }

  /** 新条目插入后的行：条目行 + 已确认图片行（新图片在写盘前不进 CL）。 */
  function entryCardToLines(card) {
    const lines = [card.lines[0]];
    for (const img of card.images || []) {
      if (img.kind === 'existing') lines.push(`![${img.alt}](${img.path})`);
    }
    return lines;
  }

  // ---------- 轻量逐词 diff（条目为单行，规模很小） ----------

  function tokenize(text) {
    return text.split(/(\s+)/).filter((t) => t !== '');
  }

  function wordDiff(oldText, newText) {
    if (oldText === newText) return [{ type: 'same', text: newText }];
    const a = tokenize(oldText);
    const b = tokenize(newText);
    if (a.length * b.length > 400000) {
      return [{ type: 'del', text: oldText }, { type: 'ins', text: newText }];
    }
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0, j = 0;
    const flush = (type, text) => {
      if (!text) return;
      const last = ops[ops.length - 1];
      if (last && last.type === type) last.text += text;
      else ops.push({ type, text });
    };
    while (i < n && j < m) {
      if (a[i] === b[j]) { flush('same', a[i]); i += 1; j += 1; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { flush('del', a[i]); i += 1; }
      else { flush('ins', b[j]); j += 1; }
    }
    while (i < n) { flush('del', a[i]); i += 1; }
    while (j < m) { flush('ins', b[j]); j += 1; }
    return ops;
  }

  const CLScratch = {
    REPO, VERSION_RE, parseTag, isStable, extractSection, pinnedLink, pinRepoLinks,
    sha256Hex, buildArchive, documentParts, splitSections, parseSection,
    serializeSection, entryCardToLines, wordDiff,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CLScratch;
  if (typeof window !== 'undefined') window.CLLib = CLScratch;
  return CLScratch;
})();
