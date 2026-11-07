// AI 后台任务：提交、轮询与进度浮条。
// 后端（serve.py /api/ai/task* + maw.editor_ai.AiTaskManager）维护
// queued → running → done/error/cancelled 状态机；前端提交后立即拿到
// queued 快照，700ms 轮询 /api/ai/tasks 刷新进度，done 后把 result 交给
// 调用方。同一时刻只跟踪一个任务，重复提交直接拒绝，避免进度 UI 混淆。
(function initMaweAiTasks(global) {
  'use strict';



  const TASK_URL = '/api/ai/task';
  const TASK_CANCEL_URL = '/api/ai/task/cancel';
  const TASKS_URL = '/api/ai/tasks';
  const POLL_INTERVAL_MS = 700;
  const DONE_HIDE_DELAY_MS = 1600;
  const ERROR_HIDE_DELAY_MS = 8000;
  const CANCELLED_HIDE_DELAY_MS = 1600;

  // 后端 stage → 进度条文案；未知 stage 直接展示原文，空 stage 用通用文案。
  const STAGE_LABELS = Object.freeze({
    submitting: '正在提交…',
    queued: '排队中…',
    starting: '启动中…',
    connecting: '连接供应商…',
    waiting_provider: '等待供应商响应…',
    waiting_edit: '结果已生成，等待结束字幕编辑…',
    applying: '正在应用结果…',
    done: '完成',
    cancelled: '已取消',
  });



  // 当前跟踪的任务：{ id, kind, label, settled, timer, hideTimer, resolve, reject }。
  let active = null;



  const element = (id) => document.getElementById(id);


  function stopTimer() {
    if (active?.timer) clearInterval(active.timer);
    if (active?.timer) active.timer = 0;
  }


  function scheduleHide(delayMs) {
    if (active?.hideTimer) clearTimeout(active.hideTimer);
    if (active) {
      active.hideTimer = setTimeout(hideProgress, delayMs);
    }
  }


  function hideProgress() {
    const box = element('ai-task-progress');
    if (box) {
      box.hidden = true;
      box.classList.remove('is-error');
    }
    const bar = element('ai-task-progress-bar');
    if (bar) bar.setAttribute('value', '0');
    if (active?.hideTimer) {
      clearTimeout(active.hideTimer);
      active.hideTimer = 0;
    }
  }


  // percent<=0 视为不定进度：<progress> 去掉 value 显示浏览器原生不定态。
  function renderTask(task) {
    const box = element('ai-task-progress');
    if (!box || !active) return;
    box.hidden = false;
    box.classList.remove('is-error');
    const stageText = STAGE_LABELS[task.stage] || task.stage || '处理中…';
    const label = element('ai-task-progress-label');
    if (label) label.textContent = `${active.label} · ${stageText}`;
    const percentText = element('ai-task-progress-percent');
    const bar = element('ai-task-progress-bar');
    const cancel = element('ai-task-progress-cancel');
    if (cancel) {
      const discard = ['waiting_edit', 'applying'].includes(task.stage);
      const action = discard ? '丢弃尚未应用的 AI 结果' : '取消此 AI 任务';
      const translated = global.MAWE_I18N?.translateText?.(action) || action;
      cancel.title = translated;
      cancel.setAttribute('aria-label', translated);
      cancel.textContent = global.MAWE_I18N?.translateText?.(discard ? '丢弃' : '取消') || (discard ? '丢弃' : '取消');
    }
    // LLM 的 connecting / waiting_provider 是阶段而非可测的完成百分比。
    const percent = ['submitting', 'queued', 'starting', 'connecting', 'waiting_provider', 'waiting_edit', 'applying'].includes(task.stage)
      ? NaN : Number(task.percent);
    if (Number.isFinite(percent) && percent > 0) {
      if (percentText) percentText.textContent = `${percent}%`;
      if (bar) bar.setAttribute('value', String(Math.min(100, Math.max(0, percent))));
    } else {
      if (percentText) percentText.textContent = '…';
      if (bar) bar.removeAttribute('value');
    }
  }


  function showError(message) {
    const box = element('ai-task-progress');
    if (!box) return;
    box.hidden = false;
    box.classList.add('is-error');
    const label = element('ai-task-progress-label');
    if (label) label.textContent = message;
    const percentText = element('ai-task-progress-percent');
    if (percentText) percentText.textContent = '';
    const bar = element('ai-task-progress-bar');
    if (bar) bar.setAttribute('value', '0');
    scheduleHide(ERROR_HIDE_DELAY_MS);
  }


  function settle() {
    stopTimer();
    if (active) active.settled = true;
  }


  function fail(message) {
    const reject = active?.reject;
    settle();
    showError(message);
    reject?.(new Error(message));
  }


  async function succeed(task) {
    const current = active;
    if (!current || current.settled || current.phase !== 'running') return;
    stopTimer();
    if (current.beforeComplete) {
      current.phase = 'applying';
      renderTask({ ...task, stage: 'applying', percent: 0 });
      try {
        const ready = await current.beforeComplete(
          () => active === current && !current.settled,
          task.result || {},
          () => {
            if (active !== current || current.settled) return;
            current.phase = 'waiting_edit';
            renderTask({ ...task, stage: 'waiting_edit', percent: 0 });
          },
        );
        if (active !== current || current.settled) return;
        if (!ready) { fail('工程或媒体已切换，已丢弃本次 AI 结果'); return; }
      } catch (error) {
        if (active === current && !current.settled) fail(error?.message || String(error));
        return;
      }
    }
    if (active !== current || current.settled) return;
    const resolve = current.resolve;
    settle();
    renderTask({ ...task, stage: 'done', percent: 100 });
    scheduleHide(DONE_HIDE_DELAY_MS);
    resolve?.(task.result || {});
  }


  function markCancelled() {
    const reject = active?.reject;
    settle();
    const box = element('ai-task-progress');
    if (box) box.classList.remove('is-error');
    const label = element('ai-task-progress-label');
    if (label && active) label.textContent = `${active.label} · 已取消`;
    const percentText = element('ai-task-progress-percent');
    if (percentText) percentText.textContent = '';
    scheduleHide(CANCELLED_HIDE_DELAY_MS);
    reject?.(new Error('AI 任务已取消'));
  }



  async function pollOnce(taskId) {
    const response = await MaweHost.server.fetch(TASKS_URL, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || !body?.ok) {
      throw new Error(body?.error || `获取任务状态失败（HTTP ${response.status}）`);
    }
    return (Array.isArray(body.tasks) ? body.tasks : []).find((task) => task.id === taskId) || null;
  }


  async function tick() {
    const current = active;
    if (!current || current.settled || !current.id || current.phase !== 'running') return;
    let task = null;
    try {
      task = await pollOnce(current.id);
    } catch (error) {
      // await 期间任务可能已切换或终结：迟到的旧响应直接作废（#6）。
      if (active !== current || current.settled || current.phase !== 'running') return;
      fail(`无法获取 AI 任务状态：${error.message || error}`);
      return;
    }
    if (active !== current || current.settled || current.phase !== 'running') return;
    if (!task) {
      fail('AI 任务不存在或已过期');
      return;
    }
    if (task.status === 'done') succeed(task);
    else if (task.status === 'error') fail(task.error || 'AI 任务失败');
    else if (task.status === 'cancelled') markCancelled();
    else renderTask(task);
  }


  function requestCancellation(id) {
    return MaweHost.server.fetch(TASK_CANCEL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestToken: MaweBoot.SERVER_CONFIG.requestToken, id }),
    }).then(async (response) => {
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error(body?.error || '取消 AI 任务失败');
    });
  }

  function cancelCurrent() {
    const current = active;
    if (!current || current.settled) return Promise.resolve();
    if (!current.id) {
      current.cancelRequested = true;
      markCancelled();
      return Promise.resolve();
    }
    if (current.phase !== 'running') {
      markCancelled();
      return Promise.resolve();
    }
    return requestCancellation(current.id).catch((error) => {
      // 取消失败不打断轮询：任务可能刚好完成；下一次 tick 会给出终态。
      if (active !== current || active.settled) return;
      fail(`取消失败：${error.message || error}`);
    });
  }



  /**
   * 提交一个 AI 后台任务并跟踪进度。
   * @param {string} kind 后端 TASK_RUNNERS 注册的任务类型
   * @param {Record<string, unknown>} payload 任务负载（仅提交时发送，不回传）
   * @param {string} label 进度浮条标题
   * @returns {Promise<Record<string, unknown>>} resolve 为任务 result
   */
  function begin(kind, payload = {}, label = 'AI 任务', { beforeComplete = null } = {}) {
    MaweAiSettings.ensureServerAvailable();
    if (active && !active.settled) {
      return Promise.reject(new Error('已有 AI 任务进行中，请等它完成或取消后再试'));
    }
    hideProgress();
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    active = { id: '', kind, label, settled: false, timer: 0, hideTimer: 0, resolve, reject, beforeComplete, phase: 'running' };
    const current = active;
    renderTask({ stage: 'submitting', percent: 0 });
    MaweHost.server.fetch(TASK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestToken: MaweBoot.SERVER_CONFIG.requestToken, kind, payload }),
    }).then(async (response) => {
      const body = await response.json();
      if (!response.ok || !body?.ok || !body?.task?.id) {
        throw new Error(body?.error || `提交 AI 任务失败（HTTP ${response.status}）`);
      }
      if (current.cancelRequested) {
        void requestCancellation(body.task.id).catch(() => {});
        return;
      }
      if (active !== current || current.settled) return;
      current.id = body.task.id;
      renderTask(body.task);
      current.timer = setInterval(() => { tick(); }, POLL_INTERVAL_MS);
    }).catch((error) => {
      if (active !== current || current.settled) return;
      const message = error?.message || String(error);
      if (!current.id) {
        // 提交阶段失败：没有可跟踪的任务，直接收起浮条并拒绝。
        settle();
        hideProgress();
        reject?.(new Error(message));
        return;
      }
      fail(message);
    });
    return promise;
  }



  // 右键菜单「AI 处理」子菜单。targets 是选中的字幕下标；文本任务在
  // MaweAiTextTasks 内构建快照并回写，这里只负责入口与可用性标注。
  function appendContextMenu(container, targets = []) {
    const { wrapper, list } = MaweContextMenus.createContextSubmenu('AI 处理', 'ai-actions');
    const closeMenu = () => MaweDom.ctxmenu.classList.remove('show');
    const addEntry = (label, fn, { disabled = false, hint = '' } = {}) => {
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.className = 'item' + (disabled ? ' disabled' : '');
      const text = document.createElement('span');
      text.textContent = label;
      entry.appendChild(text);
      if (hint) entry.title = hint;
      if (!disabled) {
        entry.addEventListener('click', () => {
          closeMenu();
          fn(targets);
        });
      }
      list.appendChild(entry);
    };
    const addSeparator = () => {
      const separator = document.createElement('div');
      separator.className = 'sep';
      list.appendChild(separator);
    };
    const textTask = (kind) => (selected) => MaweAiTextTasks.runTextTask(kind, selected);
    const hasTargets = targets.length > 0;
    addEntry('加粗关键词…', textTask('ai-bold'), {
      disabled: !hasTargets,
      hint: 'AI 为每条字幕的核心词添加 ** 强调标记（可撤销）',
    });
    const customTranslation = Boolean(MaweAiTextTasks.customPrompts?.['ai-translate']);
    const suggestedLanguage = hasTargets ? MaweAiTextTasks.translationSuggestion(targets) : 'zh';
    if (customTranslation) {
      addEntry('按自定义提示词翻译…', textTask('ai-translate'), { disabled: !hasTargets, hint: '目标语言由自定义翻译提示词决定' });
    } else {
      const hint = '优先按副轨的中英文语言翻译；否则中日韩译英文，其他译中文。可自定义提示词';
      addEntry(suggestedLanguage === 'zh' ? '译为中文副字幕（建议）' : '译为中文副字幕',
        (selected) => MaweAiTextTasks.runTextTask('ai-translate', selected, { targetLanguage: 'zh' }), { disabled: !hasTargets, hint });
      addEntry(suggestedLanguage === 'en' ? '译为英文副字幕（建议）' : '译为英文副字幕',
        (selected) => MaweAiTextTasks.runTextTask('ai-translate', selected, { targetLanguage: 'en' }), { disabled: !hasTargets, hint });
    }
    addEntry('Emoji 点缀…', textTask('ai-emoji'), {
      disabled: !hasTargets,
      hint: 'AI 为每条字幕开头添加一个贴切的 emoji（可撤销）',
    });
    addSeparator();
    const structure = global.MaweAiStructureTasks;
    const timecodeReady = Boolean(MaweBoot.SERVER_CONFIG?.sourceMediaId);
    addEntry('AI 拆分建议…', () => structure?.runSuggestSplit(targets), {
      disabled: !hasTargets,
      hint: 'AI 建议一个断句位置并直接拆分（可撤销）',
    });
    addEntry('AI 智能合并…', () => structure?.runSmartMerge(targets), {
      disabled: targets.length < 2,
      hint: '先合并选中的连续字幕，再由 AI 修顺合并缝（可撤销）',
    });
    addEntry('时间码→字词…', () => structure?.runTimecodeItems(targets), {
      disabled: !hasTargets || !timecodeReady,
      hint: timecodeReady
        ? '用本地对齐模型为选中字幕生成字词级时间码'
        : '当前编辑器没有绑定媒体，无法做时间码对齐',
    });
    addSeparator();
    addEntry('AI 提示词设置…', () => {
      if (global.MaweAiTextTasks?.openPromptsModal) global.MaweAiTextTasks.openPromptsModal();
    });
    addEntry('打开 AI 设置…', () => {
      if (global.MaweAi?.openSettings) global.MaweAi.openSettings();
    });
    container.appendChild(wrapper);
  }



  global.MaweAiTasks = Object.freeze({
    begin,
    cancelCurrent,
    appendContextMenu,
    get active() { return active && !active.settled ? active : null; },
  });
})(typeof window !== 'undefined' ? window : globalThis);
