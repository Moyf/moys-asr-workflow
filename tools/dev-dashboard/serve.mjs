#!/usr/bin/env node
// MAW Dev Dashboard —— 维护者本地 PR 看板服务器。
//
// 职责边界：
// - 通过 gh CLI 读取仓库的 PR / milestone / CI 汇总数据，服务端不保存任何令牌；
// - 扫描 docs/logs 下的 verification checklist front-matter；
// - 读写维护者的自定义 PR 状态（.artifacts/dev-dashboard/status.json，不入库）；
// - 静态托管本工具页面与 tools/changelog-editor（供面板一键打开）。
//
// 安全模型：仅绑定 127.0.0.1；校验 Host 头（防 DNS rebinding）；静态文件限定
// 白名单目录并禁止路径穿越；无认证，请勿用 --host 暴露到非回环地址（也不提供该选项）。

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const TOOL_DIR = __dirname;
export const CHANGELOG_EDITOR_DIR = path.join(REPO_ROOT, 'tools', 'changelog-editor');
export const DOCS_LOGS_DIR = path.join(REPO_ROOT, 'docs', 'logs');
export const DATA_DIR = path.join(REPO_ROOT, '.artifacts', 'dev-dashboard');
export const STATUS_FILE = path.join(DATA_DIR, 'status.json');
export const DEFAULT_PORT = 8262;
export const GITHUB_REPO_FALLBACK = 'Moyf/moys-asr-workflow';

// ---------------------------------------------------------------- 纯逻辑函数
// （无副作用，node --test 直接覆盖）

/** 从 git remote URL 提取 owner/repo；解析失败返回 null。 */
export function extractOwnerRepo(remoteUrl) {
  if (typeof remoteUrl !== 'string') return null;
  const ssh = remoteUrl.match(/^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

/**
 * 解析 checklist MD 的 YAML front-matter（子集：顶层标量字段）。
 * 非清单文件或缺少必填 status 时返回 null（与 build.py 的契约一致）。
 */
export function parseChecklistFrontMatter(text) {
  if (typeof text !== 'string') return null;
  const body = text.replace(/^\uFEFF/, '');
  if (!body.startsWith('---')) return null;
  const end = body.indexOf('\n---', 3);
  if (end === -1) return null;
  const fields = {};
  for (const rawLine of body.slice(3, end).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    if (!key) continue;
    fields[key] = line.slice(sep + 1).trim();
  }
  if (!fields.status) return null;
  const prNumber = Number.parseInt(fields.pr, 10);
  return {
    task: fields.task ?? '',
    pr: Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null,
    date: fields.date ?? '',
    status: fields.status,
  };
}

/** 把清单按 PR 分组：Map<prNumber, 清单[]>；未挂 PR 的清单跳过。 */
export function groupChecklistsByPr(checklists) {
  const byPr = new Map();
  for (const item of Array.isArray(checklists) ? checklists : []) {
    if (!item || !Number.isInteger(item.pr)) continue;
    if (!byPr.has(item.pr)) byPr.set(item.pr, []);
    byPr.get(item.pr).push(item);
  }
  return byPr;
}

/**
 * CI 检查汇总：'ok' | 'failing' | 'running' | 'none'。
 * statusCheckRollup 混合 CheckRun（conclusion）与 StatusContext（state，
 * 取值小写 success/failure/error/pending 等）两种形态，统一大写后宽匹配。
 */
export function summarizeChecks(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  const GOOD = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'EXPECTED']);
  const BAD = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR', 'STALE']);
  let bad = false;
  let running = false;
  for (const check of rollup) {
    const conclusion = String(check?.conclusion ?? check?.state ?? '').toUpperCase();
    if (BAD.has(conclusion)) {
      bad = true;
    } else if (!GOOD.has(conclusion)) {
      running = true; // 无结论且不在已知集合 → 进行中 / 未知
    }
  }
  if (bad) return 'failing';
  if (running) return 'running';
  return 'ok';
}

/** 读取自定义状态表；文件不存在视为空表。 */
export async function readStatusMap(filePath = STATUS_FILE) {
  try {
    const data = JSON.parse(await readFile(filePath, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return data;
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
}

/** 原子写入状态表（tmp + rename）。 */
export async function writeStatusMap(map, filePath = STATUS_FILE) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  await rename(tmp, filePath);
}

// 状态写入串行化：单人使用竞态概率极低，但读-改-写用队列兜底更稳。
let statusWriteChain = Promise.resolve();
export function enqueueStatusWrite(task) {
  const run = statusWriteChain.then(task, task);
  statusWriteChain = run.catch(() => {});
  return run;
}

/** 递归扫描 docs/logs 下的 *.checklist.md，返回带 front-matter 的清单列表。 */
export async function listChecklists(dir = DOCS_LOGS_DIR) {
  const out = [];
  async function walk(current, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // 目录不存在（如全新 clone）时静默返回空表
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.name.endsWith('.checklist.md')) continue;
      let fm = null;
      try {
        fm = parseChecklistFrontMatter(await readFile(full, 'utf8'));
      } catch {
        continue; // 单个文件读不出来不影响整体
      }
      if (!fm) continue;
      out.push({
        file: path.relative(REPO_ROOT, full).split(path.sep).join('/'),
        absPath: full,
        ...fm,
      });
    }
  }
  await walk(dir, 0);
  out.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  return out;
}

// ---------------------------------------------------------------- 数据获取

async function resolveRepo() {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', REPO_ROOT, 'remote', 'get-url', 'origin'],
      { timeout: 10_000 },
    );
    return extractOwnerRepo(stdout.trim()) ?? GITHUB_REPO_FALLBACK;
  } catch {
    return GITHUB_REPO_FALLBACK;
  }
}

async function fetchOpenPullRequests() {
  const repo = await resolveRepo();
  const { stdout } = await execFileAsync(
    'gh',
    [
      'pr', 'list',
      '--repo', repo,
      '--state', 'open',
      '--limit', '100',
      '--json', 'number,title,url,author,headRefName,baseRefName,isDraft,milestone,updatedAt,statusCheckRollup,labels',
    ],
    { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const prs = JSON.parse(stdout);
  prs.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  return prs;
}

// ---------------------------------------------------------------- HTTP 骨架

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, { error: message }, status);
}

// 面板自身不加载外部资源，用最严策略。
const STRICT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'";
// changelog-editor 是自包含工具页：主脚本与样式内联，粘贴图片预览用 blob:，
// 归档图片引用 raw.githubusercontent.com，策略必须放行这三类资源。
const EDITOR_CSP = "default-src 'self' 'unsafe-inline' data: blob: https:; connect-src 'self'";

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/** 面板自身的静态资源（精确映射，不开放目录列出）。 */
const PANEL_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/style.css', 'style.css'],
]);

function serveStatic(pathname, res) {
  const panelFile = PANEL_FILES.get(pathname);
  if (panelFile) {
    return sendStaticFile(path.join(TOOL_DIR, panelFile), res, STRICT_CSP);
  }
  if (pathname.startsWith('/changelog-editor/')) {
    const name = pathname.slice('/changelog-editor/'.length);
    // 只允许单段文件名，杜绝路径穿越。
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
      return sendError(res, 404, 'Not Found');
    }
    return sendStaticFile(path.join(CHANGELOG_EDITOR_DIR, name), res, EDITOR_CSP);
  }
  return sendError(res, 404, 'Not Found');
}

async function sendStaticFile(filePath, res, csp) {
  const type = STATIC_TYPES[path.extname(filePath).toLowerCase()];
  if (!type) return sendError(res, 404, 'Not Found');
  let data;
  try {
    data = await readFile(filePath);
  } catch {
    return sendError(res, 404, 'Not Found');
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function isAllowedHost(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 请求处理（导出以便测试注入 statusFile）。 */
export async function handleRequest(req, res, options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const statusFile = options.statusFile ?? STATUS_FILE;
  try {
    if (!isAllowedHost(String(req.headers.host ?? ''), port)) {
      return sendError(res, 403, 'Host 不在允许列表');
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname);
    } catch {
      return sendError(res, 400, '非法路径');
    }

    if (req.method === 'GET') {
      if (pathname === '/api/prs') return sendJson(res, await fetchOpenPullRequests());
      if (pathname === '/api/checklists') return sendJson(res, await listChecklists());
      if (pathname === '/api/status') return sendJson(res, await readStatusMap(statusFile));
      return serveStatic(pathname, res);
    }

    if (req.method === 'POST' && pathname === '/api/status') {
      // CSRF 防线：浏览器跨源请求的 Origin 不是本服务；no-cors 模式只能发
      // text/plain 等简单类型，发不出 application/json。两者都卡住才放行写操作。
      const origin = String(req.headers.origin ?? '');
      if (origin && !isAllowedHost(origin.replace(/^https?:\/\//, ''), port)) {
        return sendError(res, 403, 'Origin 不在允许列表');
      }
      const contentType = String(req.headers['content-type'] ?? '');
      if (!contentType.toLowerCase().includes('application/json')) {
        return sendError(res, 415, 'Content-Type 必须是 application/json');
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendError(res, 400, err.message);
      }
      const pr = Number(body?.pr);
      const status = body?.status ?? null;
      if (!Number.isInteger(pr) || pr <= 0) return sendError(res, 400, 'pr 必须是正整数');
      if (status !== null && (typeof status !== 'string' || status.length === 0 || status.length > 32)) {
        return sendError(res, 400, 'status 必须是 1-32 字符的字符串或 null');
      }
      // 读-改-写必须整体入队：只把写入入队的话，两个并发请求会基于同一份
      // 旧状态各自写回，后者静默覆盖前者的分配。
      const map = await enqueueStatusWrite(async () => {
        const current = await readStatusMap(statusFile);
        if (status === null) delete current[String(pr)];
        else current[String(pr)] = status;
        await writeStatusMap(current, statusFile);
        return current;
      });
      return sendJson(res, map);
    }

    return sendError(res, 404, 'Not Found');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || /command not found|ENOENT/i.test(String(err.message)))) {
      return sendError(res, 500, '找不到 gh 命令，请确认已安装并登录 GitHub CLI');
    }
    if (err && (err.killed || /timed? ?out/i.test(String(err.message)))) {
      return sendError(res, 504, 'gh 请求超时，稍后重试');
    }
    return sendError(res, 502, `数据获取失败：${err?.message ?? err}`);
  }
}

export function startServer({ port = DEFAULT_PORT } = {}) {
  const server = createServer((req, res) => {
    handleRequest(req, res, { port }).catch((err) => {
      sendError(res, 500, `服务器内部错误：${err?.message ?? err}`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', short: 'p', default: String(DEFAULT_PORT) },
      open: { type: 'boolean', default: false },
    },
  });
  const port = Number.parseInt(values.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`无效端口：${values.port}`);
    process.exitCode = 2;
    return;
  }
  const server = await startServer({ port });
  const url = `http://127.0.0.1:${port}/`;
  console.log(`MAW Dev Dashboard 已启动 → ${url}`);
  console.log('Ctrl+C 退出。状态数据存于 .artifacts/dev-dashboard/status.json（不入库）。');
  if (values.open) {
    const { spawn } = await import('node:child_process');
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  }
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
