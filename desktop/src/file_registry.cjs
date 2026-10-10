'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const PROJECT_EXTENSIONS = new Set(['.mosp', '.json']);
const MEDIA_EXTENSIONS = new Set([
  '.aac', '.aif', '.aiff', '.alac', '.avi', '.flac', '.flv', '.m4a', '.m4v',
  '.mkv', '.mov', '.mp3', '.mp4', '.mpeg', '.mpg', '.ogg', '.opus', '.wav',
  '.webm', '.wma', '.wmv',
]);

function createFileRegistry({ fs, pathModule = path, randomId = crypto.randomUUID, maxEntries = 256 }) {
  const entries = new Map();

  function register(filePath, expectedKind = 'any') {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new TypeError('文件路径不可用');
    }
    const absolutePath = pathModule.resolve(filePath);
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) throw new TypeError('请选择文件');
    const extension = pathModule.extname(absolutePath).toLowerCase();
    const kind = PROJECT_EXTENSIONS.has(extension) ? 'project'
      : MEDIA_EXTENSIONS.has(extension) ? 'media' : 'other';
    if (expectedKind !== 'any' && expectedKind !== kind) {
      throw new TypeError(expectedKind === 'project'
        ? '请选择 .mosp 或 .json 工程文件'
        : '请选择支持的音频或视频文件');
    }
    if (kind === 'other') throw new TypeError('不支持此文件类型');
    const id = randomId();
    const entry = Object.freeze({
      id,
      kind,
      name: pathModule.basename(absolutePath),
      displayPath: absolutePath,
      path: absolutePath,
    });
    entries.set(id, entry);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return entry;
  }

  function get(id, expectedKind) {
    const entry = typeof id === 'string' ? entries.get(id) : null;
    if (!entry || (expectedKind && entry.kind !== expectedKind)) return null;
    return entry;
  }

  function clear() {
    entries.clear();
  }

  return Object.freeze({ register, get, clear, get size() { return entries.size; } });
}

module.exports = { createFileRegistry };
