import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.resolve(process.env.MAW_SOURCE_DIR || path.join(siteRoot, '..'));
const outputRoot = path.join(siteRoot, 'src', 'pages', 'docs');
const assetRoot = path.join(siteRoot, 'public', 'docs-assets');
const imageSources = new Set();
const githubRoot = 'https://github.com/Moyf/moys-asr-workflow/blob/main';
const rawRoot = 'https://raw.githubusercontent.com/Moyf/moys-asr-workflow/main';

// Keep this list deliberately curated. Internal notes can stay in the source
// repository without becoming part of the public site navigation by accident.
const documents = [
  {
    source: 'docs/README.md',
    slug: 'documentation-index',
    title: '文档索引',
    description: '按任务查找使用指南、工程契约与历史记录。',
  },
  {
    source: 'docs/LAUNCHER_GUIDE.md',
    slug: 'launcher',
    title: 'Launcher 指南',
    description: '识别设置、音轨、预设、批量队列和输出目录。',
  },
  {
    source: 'docs/FAQ.md',
    slug: 'faq',
    title: '常见问题',
    description: '启动、FFmpeg、API、媒体加载与保存排错。',
  },
  {
    source: 'docs/TOOLBOX.md',
    slug: 'toolbox',
    title: 'Launcher 工具箱',
    description: '文稿匹配、AI 整理、翻译、时间码与媒体处理。',
  },
  {
    source: 'docs/POSTPROCESS_PIPELINE.md',
    slug: 'postprocess-pipeline',
    title: '转写后自动处理',
    description: '处理步骤、连接预检、中间产物与失败重试。',
  },
  {
    source: 'docs/ASS_STYLES.md',
    slug: 'ass-styles',
    title: 'ASS 样式与导出',
    description: '共享样式库、ASS 预览、特殊文本与多轨呈现。',
  },
  {
    source: 'docs/MULTI_SUBTITLE.md',
    slug: 'multi-subtitle',
    title: '多重字幕',
    description: '主副字幕导入、绑定、联动与导出的完整规则。',
  },
  {
    source: 'README.md',
    slug: 'getting-started',
    title: '开始使用 MAW',
    description: 'MAW 的产品简介、安装方式和第一次转写的完整入口。',
  },
  {
    source: 'docs/WORKFLOW.md',
    slug: 'workflow',
    title: '从零完成一次字幕工程',
    description: '从安装依赖、配置 API Key 到转写、编辑和导出的完整工作流。',
  },
  {
    source: 'docs/PROVIDERS.md',
    slug: 'providers',
    title: 'ASR 服务与配置',
    description: '服务商选择、API Key、费用和隐私边界。',
  },
  {
    source: 'docs/EDITOR_GUIDE.md',
    slug: 'editor-guide',
    title: 'MAWE 编辑器指南',
    description: '字幕编辑、波形操作、拆分合并、导出和工程文件的使用说明。',
  },
  {
    source: 'docs/CLI.md',
    slug: 'cli',
    title: '命令行 CLI',
    description: 'Release 包的转写参数、Server 管理、退出码和自动化调用模板。',
  },
  {
    source: 'JSON_SCHEMA.md',
    slug: 'json-schema',
    title: '字幕工程文件规范',
    description: '定义 .mosp / .json 工程的字段、时间码、波形和工作区数据边界。',
  },
  {
    source: 'docs/KEYBOARD_ADJUSTMENT.md',
    slug: 'keyboard-adjustment',
    title: '字幕按键调整',
    description: '用快捷键微调字幕整体位置、起点和终点。',
  },
  {
    source: 'docs/LOCAL_ASR.md',
    slug: 'local-asr',
    title: '实验性本地 ASR',
    description: '本地模型入口、安装方式和 Beta 使用边界。',
  },
  {
    source: 'docs/LLM_POSTPROCESS_PROTOCOL.md',
    slug: 'llm-postprocess',
    title: 'LLM 字幕后处理协议',
    description: '字幕后处理的输入、输出与安全边界。',
  },
  {
    source: 'docs/OCR_SUBTITLE_DEDUP.md',
    slug: 'ocr-subtitle-dedup',
    title: 'OCR 字幕去重',
    description: '画面字幕识别、去重规则、报告和性能说明。',
  },
  {
    source: 'docs/MOSE.md',
    slug: 'mose',
    title: 'MOSE 独立编辑器',
    description: 'Electron 原生工程操作、三端打包、系统打开方式与更新范围。',
  },
  {
    source: 'docs/ASR_PROVIDER_RESEARCH.md',
    slug: 'provider-research',
    title: 'ASR 供应商调研',
    description: 'Fun-ASR、Qwen 和豆包录音文件识别能力的接口对照与接入记录。',
  },
  {
    source: 'docs/DEVELOPMENT.md',
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
  return `${isImage ? rawRoot : githubRoot}/${normalized}${suffix}`;
}

function rewriteTarget(target, currentSource) {
  if (/^(?:[a-z]+:|\/|#)/i.test(target)) return target;

  const match = target.match(/^([^#?]*)(.*)$/);
  const destination = match?.[1] || target;
  const suffix = match?.[2] || '';
  if (!destination) return target;

  const currentDirectory = path.posix.dirname(currentSource);
  const sourcePath = normalizeSourcePath(path.posix.join(currentDirectory, destination));
  const route = routeBySource.get(sourcePath);
  if (route) return `${siteRoute(route, currentSource)}${suffix}`;
  if (/\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(sourcePath)) {
    if (sourcePath === '..' || sourcePath.startsWith('../')) {
      throw new Error(`图片路径超出源仓库：${target}`);
    }
    imageSources.add(sourcePath);
    // Relative URLs also work when Astro is deployed under BASE_PATH.
    const assetRoute = `/docs-assets/${sourcePath.split('/').map(encodeURIComponent).join('/')}`;
    return `${siteRoute(assetRoute, currentSource)}${suffix}`;
  }
  return externalUrl(sourcePath, suffix);
}

function rewriteLinks(markdown, currentSource) {
  // README may also use HTML images; include their local sources in the bundle.
  let result = markdown.replace(/((?:src|href)=")(?!https?:\/\/|\/|#)([^"\s]+)(")/gi, (_, open, target, close) => {
    return `${open}${rewriteTarget(target, currentSource)}${close}`;
  });

  // Astro treats relative Markdown images as source imports. Public assets need
  // HTML image tags so these URLs resolve from the deployed page instead.
  result = result.replace(/!\[([^\]]*)\]\(([^\s)]+)\)/g, (original, alt, target) => {
    if (/^(?:[a-z]+:|\/|#)/i.test(target)) return original;
    const url = rewriteTarget(target, currentSource);
    const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return `<img src="${escape(url)}" alt="${escape(alt)}" loading="lazy" decoding="async" />`;
  });

  result = result.replace(/(\]\()([^\s][^)]*?)(\))/g, (_, open, target, close) => {
    return `${open}${rewriteTarget(target, currentSource)}${close}`;
  });

  return result;
}

function siteRoute(route, currentSource) {
  const currentRoute = routeBySource.get(currentSource) || '/docs/';
  const relative = path.posix.relative(currentRoute, route);
  return `${relative || '.'}${route.endsWith('/') ? '/' : ''}`;
}

function sanitizeDocument(markdown, source) {
  if (source !== 'README.md') return markdown;

  // Compatibility guard for older README revisions containing demo credentials.
  // The current README has no shared credential section.
  return markdown.replace(/\n?<details>[\s\S]*?<\/details>\s*/i, '\n\n> 官网不展示共享演示凭据，请使用你自己的 ASR API Key。\n\n');
}
async function readDocument(source) {
  const localPath = path.join(sourceRoot, ...source.split('/'));
  if (existsSync(localPath)) {
    return readFile(localPath, 'utf8');
  }

  const response = await fetch(`${rawRoot}/${source}`);
  if (!response.ok) {
    throw new Error(`无法从 GitHub 读取 ${source}（HTTP ${response.status}）`);
  }
  return response.text();
}

async function syncImages() {
  for (const source of imageSources) {
    const localPath = path.join(sourceRoot, ...source.split('/'));
    let contents;
    if (existsSync(localPath)) {
      contents = await readFile(localPath);
    } else {
      const response = await fetch(`${rawRoot}/${source}`);
      if (!response.ok) throw new Error(`无法读取图片 ${source}（HTTP ${response.status}）`);
      contents = Buffer.from(await response.arrayBuffer());
    }
    const outputPath = path.join(assetRoot, ...source.split('/'));
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, contents);
  }
}

function quote(value) {
  return JSON.stringify(value);
}

async function main() {
  await mkdir(outputRoot, { recursive: true });
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

    await writeFile(path.join(outputRoot, `${document.slug}.md`), generated, 'utf8');
    synced += 1;
  }

  await syncImages();
  console.log(`已同步 ${synced} 篇 MAW 文档、${imageSources.size} 张配图 → ${path.relative(siteRoot, outputRoot)}`);
  if (sourceRoot === path.resolve(siteRoot, '..')) {
    console.log(`来源：${sourceRoot}`);
  } else {
    console.log(`来源：${sourceRoot}（MAW_SOURCE_DIR）`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
