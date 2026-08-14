// Browser capability services kept separate from editor state and commands.
(function initMaweEditorServices(global) {
  'use strict';

  function createSettingsStore({ key, storage, normalize } = {}) {
    const normalizeValue = typeof normalize === 'function' ? normalize : (value) => value;
    const getStorage = () => {
      try {
        return storage === undefined ? global.localStorage : storage;
      } catch (_) {
        return null;
      }
    };

    function read() {
      let saved = {};
      try {
        const raw = getStorage()?.getItem?.(key);
        saved = raw ? JSON.parse(raw) : {};
      } catch (_) {
        saved = {};
      }
      return normalizeValue(saved);
    }

    function write(value) {
      try {
        const target = getStorage();
        if (!target?.setItem) return false;
        target.setItem(key, JSON.stringify(value));
        return true;
      } catch (_) {
        // file://、隐私模式或配额不足时，编辑器仍应保持可用。
        return false;
      }
    }

    return Object.freeze({ read, write });
  }

  function createDownloadService({ windowRef = global, documentRef = global.document } = {}) {
    const runtime = windowRef || global;
    const documentObject = documentRef || runtime.document;
    const BlobCtor = runtime.Blob || global.Blob;
    const urlApi = runtime.URL || global.URL;
    const schedule = typeof runtime.setTimeout === 'function'
      ? runtime.setTimeout.bind(runtime)
      : global.setTimeout;

    function pickerTypes(accept) {
      return accept ? [{ description: accept.desc, accept: accept.types }] : undefined;
    }

    async function pickSaveFile(suggestedName, accept, options = {}) {
      if (typeof runtime.showSaveFilePicker !== 'function') return null;
      return runtime.showSaveFilePicker({
        ...options,
        suggestedName,
        types: pickerTypes(accept),
      });
    }

    async function writeHandle(handle, content, mime) {
      const writable = await handle.createWritable();
      await writable.write(new BlobCtor([content], { type: `${mime};charset=utf-8` }));
      await writable.close();
    }

    function downloadBlob(content, filename, mime) {
      const blob = new BlobCtor([content], { type: `${mime};charset=utf-8` });
      const url = urlApi.createObjectURL(blob);
      const anchor = documentObject.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      documentObject.body.appendChild(anchor);
      anchor.click();
      documentObject.body.removeChild(anchor);
      schedule(() => urlApi.revokeObjectURL(url), 1000);
      return true;
    }

    // 普通下载：优先系统保存框，失败后回退为传统 Blob 下载。
    async function save(content, filename, mime, accept) {
      if (typeof runtime.showSaveFilePicker === 'function') {
        try {
          const handle = await pickSaveFile(filename, accept);
          await writeHandle(handle, content, mime);
          return { ok: true, method: 'picker', name: handle.name || filename };
        } catch (error) {
          if (error?.name === 'AbortError') return { ok: false, cancelled: true };
          // 不支持当前 MIME 或安全上下文受限时，继续走传统下载。
        }
      }
      try {
        downloadBlob(content, filename, mime);
        return { ok: true, method: 'download', name: filename };
      } catch (error) {
        return { ok: false, error };
      }
    }

    // 另存为需要知道系统文件名；系统保存框不可用时交给调用方决定降级行为。
    async function saveWithPicker(content, filename, mime, accept, options = {}) {
      if (typeof runtime.showSaveFilePicker !== 'function') {
        return { ok: false, unsupported: true };
      }
      try {
        const handle = await pickSaveFile(filename, accept, options);
        await writeHandle(handle, content, mime);
        return { ok: true, name: handle.name || filename };
      } catch (error) {
        if (error?.name === 'AbortError') return { ok: false, cancelled: true };
        return { ok: false, error };
      }
    }

    // 多文件导出先选一个前缀，再用传统下载逐个触发，避免请求目录权限。
    async function pickFilename(suggestedName, accept, options = {}) {
      if (typeof runtime.showSaveFilePicker !== 'function') return { unsupported: true };
      try {
        const handle = await pickSaveFile(suggestedName, accept, options);
        return { ok: true, name: handle.name || suggestedName };
      } catch (error) {
        if (error?.name === 'AbortError') return { cancelled: true };
        return { error };
      }
    }

    return Object.freeze({ save, saveWithPicker, pickFilename, downloadBlob });
  }

  function createServerApi({ fetchRef = global.fetch, baseUrl = global.location?.href } = {}) {
    async function postJson(url, payload) {
      if (typeof fetchRef !== 'function') throw new Error('当前运行环境不支持 fetch');
      const target = new URL(String(url), baseUrl || undefined);
      const response = await fetchRef(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let result = {};
      try {
        result = await response.json();
      } catch (_) {
        result = {};
      }
      if (!response.ok || !result.ok) {
        const error = new Error(result.error || `服务器返回 ${response.status}`);
        error.status = response.status;
        Object.assign(error, result);
        throw error;
      }
      return result;
    }

    return Object.freeze({ postJson });
  }

  const api = Object.freeze({ createSettingsStore, createDownloadService, createServerApi });
  if (global.MAWE?.register) global.MAWE.register('editor-services', () => api);
})(window);
