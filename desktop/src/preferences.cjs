'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 1024 * 1024;
const preferenceKey = (key) => typeof key === 'string'
  && (key === 'mawe.language' || /^moy\.asr\.[a-zA-Z0-9_.-]{1,140}$/u.test(key));

// The target belongs to Electron's userData directory, never to renderer input.
function createPreferenceStore(target) {
  let values;
  function load() {
    if (values) return;
    values = Object.create(null);
    try {
      const contents = fs.readFileSync(target, 'utf8');
      if (Buffer.byteLength(contents) > MAX_BYTES) throw new Error('桌面偏好文件过大。');
      const stored = JSON.parse(contents);
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        for (const [key, value] of Object.entries(stored)) {
          if (preferenceKey(key) && typeof value === 'string') values[key] = value;
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        values = undefined;
        throw error;
      }
    }
  }
  function checkKey(key) {
    if (!preferenceKey(key)) throw new Error('不支持的桌面偏好名称。');
  }
  return Object.freeze({
    getItem(key) {
      checkKey(key);
      load();
      return values[key] ?? null;
    },
    setItem(key, value) {
      checkKey(key);
      if (typeof value !== 'string') throw new Error('桌面偏好内容必须是字符串。');
      load();
      if (values[key] === value) return;
      const next = { ...values, [key]: value };
      const contents = `${JSON.stringify(next, null, 2)}\n`;
      if (Object.keys(next).length > 128 || Buffer.byteLength(contents) > MAX_BYTES) {
        throw new Error('桌面偏好超过存储上限。');
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      for (const file of [target, `${target}.bak`]) {
        if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) {
          throw new Error('桌面偏好目标必须是普通文件。');
        }
      }
      if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak`);
      const temporary = path.join(path.dirname(target), `.preferences.${crypto.randomUUID()}.tmp`);
      fs.writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temporary, target);
      values = next;
    },
  });
}

module.exports = { createPreferenceStore };
