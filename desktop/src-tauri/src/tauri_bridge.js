// MOSE Tauri Bridge：让 web/editor.js 不改一行就能在 Tauri 里跑。
//
// 三件事：
// 1. Monkey-patch fetch：mose:// URL → Tauri invoke
// 2. 拦截"打开工程"按钮 + "最近工程"切换：用 Tauri 拿真实路径，模拟 file input
// 3. 拦截 reload + 自动加载关联媒体
//
// 通过 Rust include_str! 嵌入到 index.html 的 </body> 前（editor.js 之后执行）。
(function () {
  'use strict';

  var invoke =
    (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
    null;

  if (!invoke) {
    console.error('[MOSE] window.__TAURI__.core.invoke 不可用，IPC 无法工作');
    return;
  }

  // === 工具函数 ===

  function okResponse(data) {
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function errResponse(message) {
    return new Response(
      JSON.stringify({ ok: false, error: String(message) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  var mediaLoadGeneration = 0;
  var projectOpenQueue = Promise.resolve();

  // 把工程数据注入 editor.js：直接调 openProjectFile（全局函数），不模拟 file input。
  // openProjectFile 处理完后（.then），启用保存 + 更新最近工程 + 自动加载媒体。
  function loadProjectData(result) {
    if (!result || !result.ok) {
      if (result && result.error) {
        alert(result.error);
      }
      return;
    }

    var jsonContent = JSON.stringify(result.data);
    var file = new File([jsonContent], result.filename || 'untitled.mosp', {
      type: 'application/json',
    });
    var generation = ++mediaLoadGeneration;

    if (typeof openProjectFile === 'function') {
      // 串行化工程切换；旧工程的媒体任务通过 generation 检查自动失效。
      projectOpenQueue = projectOpenQueue.catch(function () {}).then(function () {
        if (generation !== mediaLoadGeneration) return false;
        return openProjectFile(file, { suppressMediaPrompt: true });
      }).then(function (success) {
        if (!success) return;
        if (generation !== mediaLoadGeneration) return;

        // 启用保存按钮 + 实时更新最近工程
        if (typeof SERVER_CONFIG !== 'undefined') {
          SERVER_CONFIG.canSave = true;
          if (!Array.isArray(SERVER_CONFIG.recentProjects)) SERVER_CONFIG.recentProjects = [];
          SERVER_CONFIG.recentProjects = SERVER_CONFIG.recentProjects.filter(function (p) {
            return p.path !== result.path;
          });
          SERVER_CONFIG.recentProjects.unshift({
            path: result.path, name: result.filename, exists: true,
          });
        }
        var saveDropdown = document.getElementById('save-project-dropdown');
        if (saveDropdown) saveDropdown.hidden = false;
        var saveBtn = document.getElementById('save-project');
        if (saveBtn) saveBtn.disabled = false;

        if (typeof configureRecentProjects === 'function') {
          configureRecentProjects();
        }

        // 自动加载关联媒体；Rust 已完成 media 字段和同目录候选解析。
        var mediaResolution = result.mediaResolution;
        var resolvedMedia = mediaResolution && mediaResolution.resolvedPath;
        if (mediaResolution && mediaResolution.status === 'conversion_needed') {
          flashHint(mediaResolution.message || 'flv 无法预览，将会自动转换成 mp4 格式');
        }
        if (resolvedMedia) {
          autoLoadMedia(resolvedMedia, generation);
        } else if (mediaResolution && mediaResolution.message) {
          flashHint(mediaResolution.message);
        }
      });
    } else {
      console.error('[MOSE] openProjectFile 函数不可用');
    }
  }

  function projectPathFromPayload(payload) {
    if (typeof payload === 'string') return payload;
    if (payload && typeof payload.path === 'string') return payload.path;
    return '';
  }

  function openProjectAtPath(path) {
    var projectPath = projectPathFromPayload(path);
    if (!projectPath) return Promise.resolve(null);
    return invoke('open_project_at_path', { path: projectPath }).then(function (result) {
      if (result && result.ok) {
        loadProjectData(result);
      } else if (result && result.error) {
        alert(result.error);
      }
      return result;
    });
  }

  function replacePlayerForMedia(isVideo) {
    var current = document.getElementById('player');
    if (!current || current.tagName === (isVideo ? 'VIDEO' : 'AUDIO')) return current;
    var replacement = document.createElement(isVideo ? 'video' : 'audio');
    replacement.id = 'player';
    replacement.preload = 'metadata';
    replacement.style.cssText = 'width:100%;display:block;';
    current.parentNode.replaceChild(replacement, current);
    if (typeof player !== 'undefined') player = replacement;
    if (typeof bindPlayerEvents === 'function') bindPlayerEvents(replacement);
    if (typeof waveformEditor !== 'undefined' && waveformEditor) waveformEditor.attachPlayer(replacement);
    return replacement;
  }

  function waitForMediaMetadata(mediaElement, name) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        finish(new Error('无法播放 ' + name + '：WebView 未能解析该媒体。'));
      }, 8000);
      function cleanup() {
        clearTimeout(timer);
        mediaElement.removeEventListener('loadedmetadata', loaded);
        mediaElement.removeEventListener('error', failed);
      }
      function finish(error) {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve();
      }
      function loaded() { finish(); }
      function failed() { finish(new Error('无法播放 ' + name + '：媒体格式或编码不受支持。')); }
      mediaElement.addEventListener('loadedmetadata', loaded, { once: true });
      mediaElement.addEventListener('error', failed, { once: true });
    });
  }

  // 自动加载媒体：先让 Rust 用 sidecar 准备浏览器可播放的 URL，再等待 metadata。
  // 直接调 openProjectFile 不经过 change handler，不会弹"选择媒体" modal。
  async function autoLoadMedia(mediaPath, generation, updateProjectMedia) {
    if (!mediaPath) return;
    if (generation !== mediaLoadGeneration) return;
    try {
      var result = await invoke('prepare_media', { path: mediaPath });
      if (generation !== mediaLoadGeneration) return;
      if (!result || !result.ok) {
        var missingMessage = result && result.error ? result.error : '关联媒体无法加载';
        console.warn('[MOSE] 媒体加载失败:', missingMessage);
        if (typeof flashHint === 'function') flashHint(missingMessage);
        return;
      }

      var mediaPlayer = replacePlayerForMedia(result.name && /\.(mp4|mkv|avi|mov|wmv|flv|webm|ts|m4v)$/i.test(result.name));
      var previousSource = mediaPlayer && (mediaPlayer.currentSrc || mediaPlayer.src || mediaPlayer.querySelector('source')?.src || '');
      var metadataPromise = waitForMediaMetadata(mediaPlayer, result.name);
      if (mediaPlayer) {
        var source = mediaPlayer.querySelector('source');
        if (source) source.src = result.url;
        else mediaPlayer.src = result.url;
        mediaPlayer.load();
      }
      try {
        await metadataPromise;
      } catch (error) {
        if (generation !== mediaLoadGeneration) return;
        if (previousSource) mediaPlayer.src = previousSource;
        else mediaPlayer.removeAttribute('src');
        mediaPlayer.load();
        if (typeof syncPlayerPlaceholder === 'function') syncPlayerPlaceholder();
        throw error;
      }
      if (generation !== mediaLoadGeneration) return;

      var mediaNameEl = document.getElementById('media-name');
      if (mediaNameEl) {
        mediaNameEl.textContent = result.name;
        mediaNameEl.classList.remove('empty');
        mediaNameEl.title = '点击复制媒体名：' + result.name;
      }
      if (updateProjectMedia && typeof DATA !== 'undefined') {
        DATA.media = result.sourcePath || mediaPath;
        if (typeof FILENAME_BASE !== 'undefined') {
          FILENAME_BASE = result.name.replace(/\.[^.]+$/, '');
        }
        if (typeof updateGapRemoveUi === 'function') updateGapRemoveUi();
      }

      console.log('[MOSE] 媒体已自动加载:', result.name);

      // 自动提取波形（调 ffmpeg sidecar，非致命——失败不影响编辑器使用）
      try {
        var wave = await invoke('extract_waveform', { mediaPath: result.sourcePath || mediaPath });
        if (generation !== mediaLoadGeneration) return;
        if (wave && wave.data) {
          if (typeof DATA !== 'undefined') {
            DATA.waveform = wave;
          }
          if (typeof waveformEditor !== 'undefined' && waveformEditor) {
            waveformEditor.setPayload(wave);
          }
          console.log('[MOSE] 波形已生成:', wave.peak_count, 'peaks');
        }
      } catch (waveErr) {
        if (generation !== mediaLoadGeneration) return;
        console.warn('[MOSE] 波形提取失败（非致命）:', waveErr);
      }
      if (typeof syncPlayerPlaceholder === 'function') syncPlayerPlaceholder();
    } catch (e) {
      if (generation !== mediaLoadGeneration) return;
      console.warn('[MOSE] 媒体加载异常:', e);
      if (typeof flashHint === 'function') {
        flashHint('媒体加载失败：' + (e && e.message ? e.message : e));
      }
    }
  }

  // === 1. Monkey-patch fetch ===

  var originalFetch = window.fetch;

  window.fetch = async function (url, options) {
    options = options || {};
    var urlStr = String(url);
    var body = {};
    try {
      body = JSON.parse(options.body || '{}');
    } catch (e) {}

    try {
      if (urlStr.indexOf('mose://save-project') !== -1) {
        return okResponse(await invoke('save_project', body));
      }
      if (urlStr.indexOf('mose://recent-projects') !== -1) {
        // "最近工程"切换：不只是记录路径，还要真正打开工程
        var result = await invoke('open_project_at_path', body);
        if (result && result.ok) {
          loadProjectData(result);
        }
        return okResponse(result);
      }
      if (urlStr.indexOf('mose://settings') !== -1) {
        return okResponse(await invoke('update_settings', body));
      }
    } catch (error) {
      return errResponse(error);
    }

    return originalFetch.call(this, url, options);
  };

  // === 2. 拦截 window.location.reload ===
  // Tauri 模式下 index.html 只在启动时渲染一次，reload 不会更新数据。
  // 数据已通过 loadProjectData 注入，直接忽略 reload。

  window.location.reload = function () {
    console.log('[MOSE] reload 已拦截（Tauri 模式用数据注入替代）');
  };

  // === 3. 拦截"打开工程"按钮 ===

  function setupOpenProjectInterceptor() {
    var openBtn = document.getElementById('open-project');
    if (!openBtn) {
      setTimeout(setupOpenProjectInterceptor, 50);
      return;
    }

    openBtn.addEventListener(
      'click',
      async function (e) {
        e.stopImmediatePropagation();
        try {
          var result = await invoke('open_project');
          if (!result || !result.ok || result.cancelled) return;
          loadProjectData(result);
        } catch (error) {
          console.error('[MOSE] 打开工程失败:', error);
        }
      },
      true
    );

    console.log('[MOSE] "打开工程"拦截器已就绪');
  }

  setupOpenProjectInterceptor();

  // Desktop 用系统选择器拿到真实媒体路径，FLV 才能交给 bundled FFmpeg 转换。
  function setupMediaInterceptor() {
    var mediaButtons = [
      document.getElementById('load-media'),
      document.getElementById('project-media-select'),
    ].filter(Boolean);
    if (!mediaButtons.length) {
      setTimeout(setupMediaInterceptor, 50);
      return;
    }
    mediaButtons.forEach(function (button) {
      button.addEventListener('click', async function (e) {
        e.stopImmediatePropagation();
        try {
          if (typeof closeProjectMediaModal === 'function') closeProjectMediaModal(true);
          var picked = await invoke('pick_media');
          if (!picked || !picked.ok || picked.cancelled) return;
          var generation = ++mediaLoadGeneration;
          if (/\.flv$/i.test(picked.name || picked.path || '')) {
            flashHint('flv 无法预览，将会自动转换成 mp4 格式');
          }
          await autoLoadMedia(picked.path, generation, true);
        } catch (error) {
          console.error('[MOSE] 选择媒体失败:', error);
          if (typeof flashHint === 'function') flashHint('选择媒体失败：' + error);
        }
      }, true);
    });
    console.log('[MOSE] 媒体选择拦截器已就绪');
  }

  setupMediaInterceptor();

  // === 4. 拦截"📁 浏览…"表情包按钮 ===
  // editor.js 的 sticker-root-pick 用浏览器 showDirectoryPicker/webkitdirectory（拿不到路径，用 blob URL）。
  // Tauri 模式改为 dialog 选目录 + Rust 扫描 → file:// URL 直接加载图片。
  function setupStickerInterceptor() {
    var pickBtn = document.getElementById('sticker-root-pick');
    if (!pickBtn) {
      setTimeout(setupStickerInterceptor, 50);
      return;
    }

    pickBtn.addEventListener(
      'click',
      async function (e) {
        e.stopImmediatePropagation();

        try {
          var result = await invoke('pick_and_scan_stickers');
          if (!result || !result.ok || result.cancelled) return;

          // 更新 STICKERS 数组（file:// URL，不需要 blob URL）
          if (typeof STICKERS !== 'undefined') {
            STICKERS.forEach(function (s) {
              if (s._blobUrl) { try { URL.revokeObjectURL(s._blobUrl); } catch (e) {} }
            });
            STICKERS.length = 0;
            result.stickers.forEach(function (s) { STICKERS.push(s); });
          }

          // STICKER_ROOT 改为实际路径（editor.js stickerUrl 会拼 file:// URL）
          if (typeof STICKER_ROOT !== 'undefined') {
            STICKER_ROOT = result.root;
          }

          var input = document.getElementById('sticker-root-input');
          if (input) input.value = result.root;
          var modal = document.getElementById('sticker-root-modal');
          if (modal) modal.classList.remove('show');

          if (typeof renderAll === 'function') renderAll();
          if (typeof flashHint === 'function') {
            flashHint('已加载 ' + result.count + ' 张表情包');
          }
        } catch (error) {
          console.error('[MOSE] 表情包加载失败:', error);
        }
      },
      true
    );

    console.log('[MOSE] 表情包拦截器已就绪');
  }

  setupStickerInterceptor();

  // === 5. 启动工程、文件关联与原生拖放 ===
  // Tauri 会在页面加载前收到命令行参数；Rust 暂存它，页面就绪后由这里取出。
  // 这也让从 Explorer 拖入的真实路径复用同一条工程/媒体解析链路。
  function nativeDropPaths(payload) {
    if (Array.isArray(payload)) return payload.filter(function (path) {
      return typeof path === 'string' && path;
    });
    if (payload && Array.isArray(payload.paths)) {
      return payload.paths.filter(function (path) {
        return typeof path === 'string' && path;
      });
    }
    return [];
  }

  function isProjectPath(path) {
    return /\.(mosp|json)$/i.test(path);
  }

  function isMediaPath(path) {
    return /\.(mp4|mkv|avi|mov|wmv|flv|webm|ts|m4v|mp3|wav|m4a|flac|aac|ogg|opus)$/i.test(path);
  }

  function hideNativeDropOverlay() {
    if (dragOverlay) dragOverlay.classList.remove('show');
  }

  function handleNativeDrop(payload) {
    hideNativeDropOverlay();
    var paths = nativeDropPaths(payload);
    var projectPath = paths.find(isProjectPath);
    if (projectPath) {
      void openProjectAtPath(projectPath).catch(function (error) {
        console.error('[MOSE] 拖放工程失败:', error);
      });
      return;
    }
    var mediaPath = paths.find(isMediaPath);
    if (mediaPath) {
      var generation = ++mediaLoadGeneration;
      void autoLoadMedia(mediaPath, generation, true);
    }
  }

  function setupNativeFileDrop() {
    var eventApi = window.__TAURI__ && window.__TAURI__.event;
    if (!eventApi || !eventApi.listen) return;
    void eventApi.listen('open-file', function (event) {
      void openProjectAtPath(event && event.payload).catch(function (error) {
        console.error('[MOSE] 关联工程打开失败:', error);
      });
    });
    void eventApi.listen('tauri://drag-enter', function () {
      if (dragOverlay) dragOverlay.classList.add('show');
    });
    void eventApi.listen('tauri://drag-leave', hideNativeDropOverlay);
    void eventApi.listen('tauri://drag-drop', function (event) {
      handleNativeDrop(event && event.payload);
    });
    void invoke('take_initial_project_path').then(function (path) {
      if (!path) return;
      return openProjectAtPath(path);
    }).catch(function (error) {
      console.error('[MOSE] 启动工程打开失败:', error);
    });
    console.log('[MOSE] 文件关联、启动工程与原生拖放监听器已就绪');
  }

  setupNativeFileDrop();

  // index.html 在构建时生成，运行时设置（最近工程、工作区）需要从本机读取一次。
  async function hydrateSettings() {
    try {
      var settings = await invoke('get_settings');
      if (!settings || typeof settings !== 'object') return;
      if (typeof SERVER_CONFIG !== 'undefined') {
        Object.assign(SERVER_CONFIG, settings);
      }
      if (typeof configureRecentProjects === 'function') configureRecentProjects();
      if (typeof configureServerProjectSettings === 'function') configureServerProjectSettings();
      if (typeof configureServerWorkspaceLibrary === 'function') configureServerWorkspaceLibrary();
    } catch (error) {
      console.warn('[MOSE] 读取本机设置失败:', error);
    }
  }

  void hydrateSettings();

  console.log('[MOSE] Tauri bridge initialized (fetch→invoke + open + media + stickers + waveform + file-assoc)');
})();
