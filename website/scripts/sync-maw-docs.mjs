import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Use the repository's existing Markdown lexer to identify block structure;
// indentation alone cannot distinguish a code block from a paragraph continuation.
const { marked } = createRequire(import.meta.url)('../../tools/shared/vendor/marked-18.1.3/marked.umd.js');

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.resolve(siteRoot, '..');
const outputSite = path.resolve(process.env.MAW_DOCS_OUTPUT_SITE || siteRoot);
const outputRoot = path.join(outputSite, 'src', 'pages', 'docs');
const assetRoot = path.join(outputSite, 'public', 'docs-assets');
const imageSources = new Set();
const githubRoot = 'https://github.com/Moyf/moys-asr-workflow/blob/main';
const rawRoot = 'https://raw.githubusercontent.com/Moyf/moys-asr-workflow/main';

// Keep this list deliberately curated. Internal notes can stay in the source
// repository without becoming part of the public site navigation by accident.
export const documents = [
  {
    source: 'docs/INDEX.md',
    slug: 'documentation-index',
    title: '文档索引',
    description: '按任务查找使用指南、工程契约与历史记录。',
  },
  {
    source: 'docs/user/LAUNCHER_GUIDE.md',
    slug: 'launcher',
    title: 'Launcher 指南',
    description: '识别设置、音轨、预设、批量队列和输出目录。',
  },
  {
    source: 'docs/user/FAQ.md',
    slug: 'faq',
    title: '常见问题',
    description: '启动、FFmpeg、API、媒体加载与保存排错。',
  },
  {
    source: 'docs/user/TOOLBOX.md',
    slug: 'toolbox',
    title: 'Launcher 工具箱',
    description: '文稿匹配、AI 整理、翻译、时间码与媒体处理。',
  },
  {
    source: 'docs/user/POSTPROCESS_PIPELINE.md',
    slug: 'postprocess-pipeline',
    title: '转写后自动处理',
    description: '处理步骤、连接预检、中间产物与失败重试。',
  },
  {
    source: 'docs/user/ASS_STYLES.md',
    slug: 'ass-styles',
    title: 'ASS 样式与导出',
    description: '共享样式库、ASS 预览、特殊文本与多轨呈现。',
  },
  {
    source: 'docs/user/MULTI_SUBTITLE.md',
    slug: 'multi-subtitle',
    title: '双语字幕',
    description: '主副字幕导入、绑定、联动与导出的完整规则。',
  },
  {
    source: 'README.md',
    slug: 'getting-started',
    title: '开始使用 MAW',
    description: 'MAW 的产品简介、安装方式和第一次转写的完整入口。',
  },
  {
    source: 'docs/user/WORKFLOW.md',
    slug: 'workflow',
    title: '从零完成一次字幕工程',
    description: '从安装依赖、配置 API Key 到转写、编辑和导出的完整工作流。',
  },
  {
    source: 'docs/user/PROVIDERS.md',
    slug: 'providers',
    title: 'ASR 服务与配置',
    description: '服务商选择、API Key、费用和隐私边界。',
  },
  {
    source: 'docs/user/EDITOR_GUIDE.md',
    slug: 'editor-guide',
    title: 'MAWE 编辑器指南',
    description: '字幕编辑、波形操作、拆分合并、导出和工程文件的使用说明。',
  },
  {
    source: 'docs/user/CLI.md',
    slug: 'cli',
    title: '命令行 CLI',
    description: 'Release 包的转写参数、Server 管理、退出码和自动化调用模板。',
  },
  {
    source: 'docs/engineering/JSON_SCHEMA.md',
    slug: 'json-schema',
    title: '字幕工程文件规范',
    description: '定义 .mosp / .json 工程的字段、时间码、波形和工作区数据边界。',
  },
  {
    source: 'docs/user/KEYBOARD_ADJUSTMENT.md',
    slug: 'keyboard-adjustment',
    title: '字幕按键调整',
    description: '用快捷键微调字幕整体位置、起点和终点。',
  },
  {
    source: 'docs/user/LOCAL_ASR.md',
    slug: 'local-asr',
    title: '实验性本地 ASR',
    description: '本地模型入口、安装方式和 Beta 使用边界。',
  },
  {
    source: 'docs/engineering/LLM_POSTPROCESS_PROTOCOL.md',
    slug: 'llm-postprocess',
    title: 'LLM 字幕后处理协议',
    description: '字幕后处理的输入、输出与安全边界。',
  },
  {
    source: 'docs/user/OCR_SUBTITLE_DEDUP.md',
    slug: 'ocr-subtitle-dedup',
    title: 'OCR 字幕去重',
    description: '画面字幕识别、去重规则、报告和性能说明。',
  },
  {
    source: 'docs/engineering/MOSE.md',
    slug: 'mose',
    title: '与 MOSE 的关系',
    description: 'MAW、MAWE 与当前实验桌面目录的定位和工程格式边界。',
  },
  {
    source: 'docs/logs/unversioned/2026-07-28/ASR_PROVIDER_RESEARCH.md',
    slug: 'provider-research',
    title: 'ASR 供应商调研',
    description: 'Fun-ASR、Qwen 和豆包录音文件识别能力的接口对照与接入记录。',
  },
  {
    source: 'docs/engineering/DEVELOPMENT.md',
    slug: 'development',
    title: '开发概览',
    description: '维护者使用的代码边界、数据持久化和发布前检查清单。',
  },
];

const routeBySource = new Map(
  documents.map((document) => [document.source, `/docs/${document.slug}/`]),
);

function normalizeSourcePath(value) {
  return path.posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\//, '');
}

function externalUrl(sourcePath, suffix = '') {
  const normalized = normalizeSourcePath(sourcePath);
  const isImage = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(normalized);
  return `${isImage ? rawRoot : githubRoot}/${normalized.split('/').map(encodeURIComponent).join('/')}${suffix}`;
}

function rewriteTarget(target, currentSource, forceImage = false) {
  if (/^(?:[a-z]+:|\/|#)/i.test(target)) return target;

  const match = target.match(/^([^#?]*)(.*)$/);
  let destination = match?.[1] || target;
  const suffix = match?.[2] || '';
  if (!destination) return target;
  try { destination = decodeURIComponent(destination); }
  catch { throw new Error(`无效的链接编码：${target}`); }

  const currentDirectory = path.posix.dirname(currentSource);
  const sourcePath = normalizeSourcePath(path.posix.join(currentDirectory, destination));
  const route = routeBySource.get(sourcePath);
  if (route && !forceImage) return `${siteRoute(route, currentSource)}${suffix}`;
  if (forceImage) {
    if (sourcePath === '..' || sourcePath.startsWith('../')) {
      throw new Error(`图片路径超出源仓库：${target}`);
    }
    if (!sourcePath.startsWith('docs/assets/')) {
      throw new Error(`官网源文档的本地配图必须位于 docs/assets/：${currentSource} → ${sourcePath}`);
    }
    imageSources.add(sourcePath);
    // Relative URLs also work when Astro is deployed under BASE_PATH.
    const assetRoute = `/docs-assets/${sourcePath.split('/').map(encodeURIComponent).join('/')}`;
    return `${siteRoute(assetRoute, currentSource)}${suffix}`;
  }
  return externalUrl(sourcePath, suffix);
}

function protectedOffsets(markdown, onLink = () => {}, onImage = () => {}) {
  const offsets = new Set();
  // Map a container's de-indented lines back to their original characters.
  function childMap(raw, mapping, content) {
    const rawLines = raw.split('\n');
    const lines = content.split('\n');
    const result = [];
    let position = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = rawLines[i] ?? '';
      let expanded = '';
      const expandedMap = [];
      // Containers can consume only part of a tab. Expand tabs before the
      // line's content, including tabs after a list or blockquote marker, but
      // retain literal tabs inside the content itself.
      const contentText = lines[i].replace(/^[ \t]*/, '');
      const contentStart = contentText ? line.lastIndexOf(contentText) : line.length;
      if (contentStart < 0) throw new Error('无法定位 Markdown 容器中的代码块');
      for (let j = 0; j < line.length; j++) {
        const expand = j < contentStart && line[j] === '\t';
        const count = expand ? 4 - expanded.length % 4 : 1;
        expanded += expand ? ' '.repeat(count) : line[j];
        for (let k = 0; k < count; k++) expandedMap.push(mapping[position + j]);
      }
      const start = lines[i] ? expanded.lastIndexOf(lines[i]) : expanded.length;
      if (start < 0) throw new Error('无法定位 Markdown 容器中的代码块');
      for (let j = 0; j < lines[i].length; j++) result.push(expandedMap[start + j]);
      position += line.length;
      if (i < lines.length - 1) result.push(mapping[position++]);
    }
    return result;
  }
  function visit(text, mapping, tokens, links = true, images = true) {
    let cursor = 0;
    for (const token of tokens) {
      const start = text.indexOf(token.raw, cursor);
      if (start < 0) throw new Error('无法定位 Markdown 代码块');
      cursor = start + token.raw.length;
      const map = mapping.slice(start, cursor);
      if (token.type === 'code') {
        for (const index of map) if (index !== undefined) offsets.add(index);
      } else if (token.type === 'html') {
        // HTML blocks can contain several tags and comments. Skip quoted tag
        // attributes so a literal "<!--" there is not mistaken for a comment.
        for (let i = 0; i < token.raw.length;) {
          const start = token.raw.indexOf('<', i);
          if (start < 0) break;
          if (token.raw.startsWith('<!--', start)) {
            const close = token.raw.indexOf('-->', start + 4);
            const end = close < 0 ? token.raw.length : close + 3;
            for (const index of map.slice(start, end)) if (index !== undefined) offsets.add(index);
            i = end;
          } else if (/^<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s|\/?>)/.test(token.raw.slice(start)) ||
                     token.raw.startsWith('<!', start) || token.raw.startsWith('<?', start)) {
            let quote = '';
            i = start + 1;
            while (i < token.raw.length) {
              const char = token.raw[i++];
              if (quote && char === quote) quote = '';
              else if (!quote && (char === '"' || char === "'")) quote = char;
              else if (!quote && char === '>') break;
            }
          } else {
            i = start + 1;
          }
        }
      } else if (token.type === 'image') {
        if (images) onImage(token, map);
        // Comments in alt text still need protection before HTML rewriting.
        if (token.tokens) visit(token.raw, map, token.tokens, links, false);
      } else if (token.type === 'link') {
        if (links) onLink(token, map);
        // Re-lex the raw label: Marked's child tokens can contain unescaped
        // text and therefore cannot always be mapped to source positions.
        const end = linkLabelEnd(token.raw);
        if (end !== null) {
          const label = token.raw.slice(1, end - 1);
          visit(label, map.slice(1, end - 1), marked.Lexer.lexInline(label, { gfm: false }), false, images);
        }
      } else if (token.type === 'blockquote') {
        visit(token.text, childMap(token.raw, map, token.text), token.tokens, links, images);
      } else if (token.type === 'list') {
        let itemCursor = 0;
        for (const item of token.items) {
          const itemStart = token.raw.indexOf(item.raw, itemCursor);
          if (itemStart < 0) throw new Error('无法定位 Markdown 列表');
          itemCursor = itemStart + item.raw.length;
          const itemMap = map.slice(itemStart, itemCursor);
          visit(item.text, childMap(item.raw, itemMap, item.text), item.tokens, links, images);
        }
      } else if (token.tokens) {
        // Inline tokens use raw slices, so nested comments can be mapped back
        // without mistaking comment-like text in a code span for a comment.
        visit(token.raw, map, token.tokens, links, images);
      }
    }
  }
  visit(markdown, Array.from({ length: markdown.length }, (_, index) => index), marked.lexer(markdown, { gfm: false }));
  return offsets;
}

function linkLabelEnd(raw) {
  if (!raw.startsWith('[')) return null;
  let depth = 1;
  let i = 1;
  let firstEnd = null;
  for (; i < raw.length && depth; i++) {
    if (raw[i] === '\\') { i++; continue; }
    if (raw[i] === '`') {
      const ticks = raw.slice(i).match(/^`+/)[0];
      const end = raw.indexOf(ticks, i + ticks.length);
      if (end >= 0) { i = end + ticks.length - 1; continue; }
    }
    if (raw[i] === '[') depth++;
    if (raw[i] === ']') {
      if (depth > 1) depth--;
      else {
        firstEnd ??= i + 1;
        if (raw[i + 1] === '(') return i + 1;
      }
    }
  }
  return firstEnd;
}

// Locate the destination in an inline link already recognized by Marked.
// Reference links and autolinks have no inline destination to replace.
function inlineDestination(raw) {
  let i = linkLabelEnd(raw);
  if (i === null || raw[i] !== '(') return null;
  i++;
  while (/\s/.test(raw[i] || '')) i++;
  const angle = raw[i] === '<';
  if (angle) i++;
  const start = i;
  let parentheses = 0;
  for (; i < raw.length; i++) {
    const char = raw[i];
    if (char === '\\') { i++; continue; }
    if (angle ? char === '>' : /\s/.test(char) || char === ')' && !parentheses) break;
    if (!angle && char === '(') parentheses++;
    if (!angle && char === ')') parentheses--;
  }
  return { start, end: i, angle };
}

function rewriteMarkdownLinks(markdown, currentSource) {
  const edits = [];
  protectedOffsets(markdown, (token, map) => {
    const destination = inlineDestination(token.raw);
    if (!destination || destination.start === destination.end) return;
    const indices = map.slice(destination.start, destination.end);
    if (indices.some((index, i) => index !== indices[0] + i)) {
      throw new Error('无法定位 Markdown 链接目标');
    }
    const rewritten = rewriteTarget(token.href, currentSource);
    if (rewritten !== token.href) {
      // Bare Markdown destinations cannot contain unmatched parentheses.
      const value = destination.angle ? rewritten : rewritten.replaceAll('(', '%28').replaceAll(')', '%29');
      edits.push({ start: indices[0], end: indices.at(-1) + 1, value });
    }
  });
  for (const edit of edits.reverse()) markdown = markdown.slice(0, edit.start) + edit.value + markdown.slice(edit.end);
  return markdown;
}

function rewriteLinks(markdown, currentSource) {
  // A shortcut such as ![example] is an image only if its reference resolves.
  // Inspect the original token tree before replacing protected source spans.
  marked.walkTokens(marked.lexer(markdown, { gfm: false }), (token) => {
    if (token.type !== 'image') return;
    if (!inlineDestination(token.raw.slice(1))) {
      throw new Error(`暂不支持引用式图片，请改用内联图片：${currentSource}`);
    }
    const titleTokens = marked.Lexer.lexInline(token.title || '', { gfm: false });
    marked.walkTokens(token.tokens || [], (child) => {
      if (child.type === 'html' && !child.raw.startsWith('<!--')) {
        throw new Error(`暂不支持此图片语法，请使用内联相对路径：${currentSource}`);
      }
    });
    marked.walkTokens(titleTokens, (child) => {
      if (child.type === 'html') throw new Error(`暂不支持此图片语法，请使用内联相对路径：${currentSource}`);
    });
  });
  markdown = rewriteMarkdownLinks(markdown, currentSource);
  const code = [];
  const protect = (value) => { const key = `\u0000MAW_CODE_${code.length}\u0000`; code.push(value); return key; };
  const indented = protectedOffsets(markdown);
  markdown = markdown.replace(/[^\n]+/g, (line, start) => {
    let result = '';
    for (let i = 0; i < line.length;) {
      let end = i + 1;
      while (end < line.length && indented.has(start + end) === indented.has(start + i)) end++;
      const part = line.slice(i, end);
      result += indented.has(start + i) ? protect(part) : part;
      i = end;
    }
    return result;
  });
  let fence = null;
  let fenced = '';
  let text = '';
  for (const line of markdown.split(/(?<=\n)/)) {
    if (fence) {
      fenced += line;
      const close = line.match(/^ {0,3}(`+|~+)[ \t]*(?:\n|$)/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        text += protect(fenced); fenced = ''; fence = null;
      }
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) { fence = open[1]; fenced = line; continue; }
    text += line.replace(/(`+)([^`\n]*?)\1/g, protect);
  }
  if (fenced) text += protect(fenced);
  markdown = text;
  // HTML attribute rewriting must not inspect the contents of a Markdown
  // image's alt text or title, including escaped tag-like text.
  const markdownImages = [];
  const imageSpans = [];
  protectedOffsets(markdown, () => {}, (token, map) => {
    if (map.some((index, i) => index !== map[0] + i)) throw new Error('无法定位 Markdown 图片');
    const key = `\u0000MAW_MARKDOWN_IMAGE_${markdownImages.length}\u0000`;
    markdownImages.push(token.raw);
    imageSpans.push({ start: map[0], end: map.at(-1) + 1, key });
  });
  for (const span of imageSpans.reverse()) markdown = markdown.slice(0, span.start) + span.key + markdown.slice(span.end);
  for (const [tag] of markdown.matchAll(/<source\b[^>]*>/gi)) {
    if (/\sdata-srcset\s*=/i.test(tag)) throw new Error(`暂不支持图片 source srcset：${currentSource}`);
    const attr = tag.match(/\ssrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
    if (attr && !/^https?:\/\/[^\s,]+$/i.test(attr[1] ?? attr[2] ?? attr[3])) {
      throw new Error(`暂不支持图片 source srcset：${currentSource}`);
    }
  }
  const htmlImages = [];
  // Protect HTML images from the general link rewrite and validate every src.
  let result = markdown.replace(/<img\b[^>]*>/gi, (tag) => {
    if (/\s(?:srcset|data-src|data-srcset)\s*=/i.test(tag)) throw new Error(`暂不支持图片 srcset 或 data-src：${currentSource}`);
    const rewritten = tag.replace(/(\s+src\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i, (_match, attribute, double, single, bare) => {
      const target = double ?? single ?? bare;
      if (/^(?:\/(?!\/)|#)/.test(target)) throw new Error(`暂不支持站点根路径图片：${currentSource}`);
      const url = rewriteTarget(target, currentSource, true).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
      return `${attribute}"${url}"`;
    });
    const key = `\u0000MAW_IMAGE_${htmlImages.length}\u0000`;
    htmlImages.push(rewritten);
    return key;
  });
  result = result.replace(/((?:src|href)=)(["'])([^"'\s]+)\2/gi, (_, attribute, quote, target) => {
    return `${attribute}${quote}${rewriteTarget(target, currentSource)}${quote}`;
  });
  result = result.replace(/\u0000MAW_MARKDOWN_IMAGE_(\d+)\u0000/g, (_, index) => markdownImages[Number(index)]);

  // Astro treats relative Markdown images as source imports. Public assets need
  // HTML image tags so these URLs resolve from the deployed page instead.
  const imageEdits = [];
  protectedOffsets(result, () => {}, (token, map) => {
    const original = token.raw;
    const match = original.match(/^!\[([^\]]*)\]\(([^\s)]+)(?:\s+(["'])(.*?)\3)?\)$/);
    if (!match || match[2].startsWith('<')) {
      if (/^(?:[a-z]+:|\/\/)/i.test(token.href)) return;
      throw new Error(`暂不支持此图片语法，请使用内联相对路径：${currentSource}`);
    }
    const [, alt, target, , title] = match;
    if (/^(?:\/(?!\/)|#)/.test(target)) throw new Error(`暂不支持站点根路径图片：${currentSource}`);
    if (/^(?:[a-z]+:|\/\/)/i.test(target)) return;
    const url = rewriteTarget(target, currentSource, true);
    const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const restore = (value) => value.replace(/\u0000MAW_CODE_(\d+)\u0000/g, (_, index) => code[Number(index)]);
    const titleAttribute = title === undefined ? '' : ` title="${escape(restore(title))}"`;
    if (map.some((index, i) => index !== map[0] + i)) throw new Error('无法定位 Markdown 图片');
    imageEdits.push({ start: map[0], end: map.at(-1) + 1,
      value: `<img src="${escape(url)}" alt="${escape(restore(alt))}"${titleAttribute} loading="lazy" decoding="async" />` });
  });
  for (const edit of imageEdits.reverse()) result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);

  return result.replace(/\u0000MAW_IMAGE_(\d+)\u0000/g, (_, index) => htmlImages[Number(index)])
    .replace(/\u0000MAW_CODE_(\d+)\u0000/g, (_, index) => code[Number(index)]);
}

function siteRoute(route, currentSource) {
  const currentRoute = routeBySource.get(currentSource) || '/docs/';
  const relative = path.posix.relative(currentRoute, route);
  return `${relative || '.'}${route.endsWith('/') ? '/' : ''}`;
}

export function sanitizeDocument(markdown, source) {
  if (source !== 'README.md') return markdown;

  // Compatibility guard for older README revisions containing demo credentials.
  // The current README has no shared credential section.
  return markdown.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, (block) => {
    const summary = (block.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1] || '')
      .replace(/<[^>]*>/g, ' ');
    const sharedPurpose = /演示|共享|临时|demo|shared|temporary/i.test(summary);
    const credentialTitle = /凭据|密钥|令牌|credentials?|\b(?:api[\s_-]*)?keys?\b|token/i.test(summary);
    const secretValue = /\bsk-[A-Za-z0-9_-]{12,}\b/.test(block);
    if (sharedPurpose && credentialTitle || secretValue) {
      return '\n\n> 官网不展示共享演示凭据，请使用你自己的 ASR API Key。\n\n';
    }
    return block;
  });
}
export function collectImageSources(markdown, source) {
  imageSources.clear();
  rewriteLinks(markdown, source);
  return [...imageSources];
}

async function safePath(source, root) {
  const parts = source.split('/');
  if (path.posix.isAbsolute(source) || parts.some((part) => !part || part === '.' || part === '..' || /^\.env(?:\.|$)/i.test(part))) {
    throw new Error(`禁止读取此源路径：${source}`);
  }
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`禁止读取符号链接：${source}`);
  }
  return current;
}
export async function readDocument(source, { root = sourceRoot } = {}) {
  try {
    return await readFile(await safePath(source, root), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`本地缺少源文档 ${source}`);
    throw error;
  }
}

export async function readImage(source, { root = sourceRoot } = {}) {
  try {
    return await readFile(await safePath(source, root));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`本地缺少配图 ${source}`);
    throw error;
  }
}

async function loadImages() {
  const images = new Map();
  for (const source of imageSources) {
    const contents = await readImage(source);
    images.set(path.join(assetRoot, ...source.split('/')), contents);
  }
  return images;
}

async function writeImages(images) {
  for (const [outputPath, contents] of images) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, contents);
  }
}

async function findStale(images, stale) {
  for (const [outputPath, contents] of images) {
    let existing = null;
    try {
      existing = await readFile(outputPath);
    } catch {
      existing = null;
    }
    if (!existing || !existing.equals(contents)) stale.push(outputPath);
  }
}

function quote(value) {
  return JSON.stringify(value);
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const validateOnly = process.argv.includes('--validate');
  const stale = [];
  const pages = new Map();
  let synced = 0;

  for (const document of documents) {
    const source = sanitizeDocument(await readDocument(document.source), document.source);
    const generated = [
      '---',
      `layout: ${quote('../../layouts/DocLayout.astro')}`,
      `title: ${quote(document.title)}`,
      `description: ${quote(document.description)}`,
      `source: ${quote(document.source)}`,
      '---',
      '',
      `<!-- Generated from ${document.source}. Run pnpm run sync:docs to refresh. -->`,
      '',
      // DocLayout already renders the page title; keep one H1 per page.
      rewriteLinks(source.replace(/^# [^\n]*(?:\n|$)/, ''), document.source).trim(),
      '',
    ].join('\n');

    const outputPath = path.join(outputRoot, `${document.slug}.md`);
    pages.set(outputPath, generated);
    synced += 1;
  }

  const images = await loadImages();
  if (validateOnly) {
    console.log(`MAW_IMAGES=${JSON.stringify([...imageSources].sort())}`);
    return;
  }
  for (const [outputPath, generated] of pages) {
    if (checkOnly) {
      let existing = null;
      try {
        existing = await readFile(outputPath, 'utf8');
      } catch {
        existing = null;
      }
      if (existing !== generated) stale.push(outputPath);
    } else {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, generated, 'utf8');
    }
  }

  if (checkOnly) {
    await findStale(images, stale);
  } else {
    await writeImages(images);
  }

  const summary = `${checkOnly ? '已检查' : '已同步'} ${synced} 篇 MAW 文档、${images.size} 张配图 → ${path.relative(siteRoot, outputRoot)}`;
  console.log(summary);
  console.log(`来源：${sourceRoot}`);
  if (process.env.MAW_DOCS_PRINT_IMAGES === '1') console.log(`MAW_IMAGES=${JSON.stringify([...imageSources].sort())}`);

  if (checkOnly && stale.length) {
    for (const file of stale) console.error(`过期：${path.relative(siteRoot, file)}`);
    console.error(`共 ${stale.length} 处生成副本与源文档不一致；运行 pnpm run sync:docs 刷新。`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
