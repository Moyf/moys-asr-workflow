// 检查工程明确保存的字体；自动建立的默认轨道样式不要求用户安装字体。
(function initProjectFontCheck(global) {
  'use strict';
  let serial = 0;
  let panel = null;
  // These are explicitly selected preview presets, not the default fallback.
  const previewFamilies = Object.freeze({
    yahei: ['Microsoft YaHei', 'PingFang SC'],
    hei: ['SimHei', 'Microsoft YaHei'],
    song: ['SimSun', 'Songti SC'],
    sans: ['Arial', 'Segoe UI'],
  });

  function projectNames() {
    const preview = MaweBoot.DATA.preview;
    const names = [preview?.subtitle?.font_family, preview?.extension_subtitle?.font_family];
    const styles = new Map((MaweBoot.DATA.styles || []).map(style => [style.id, style]));
    for (const track of MaweBoot.DATA.tracks || []) {
      if (track.style && track.style.font_default !== true) names.push(styles.get(track.style.style_id)?.fontName);
      for (const segment of track.segments || []) names.push(segment.assStyle?.fontName);
    }
    return [...new Set(names
      .filter(name => typeof name === 'string' && name.trim() && name.trim() !== 'default')
      .map(name => name.trim()))];
  }

  function close() {
    panel?.remove();
    panel = null;
  }

  function applyReplacements(replacements) {
    const preview = MaweBoot.DATA.preview;
    const main = preview?.subtitle?.font_family;
    const extension = preview?.extension_subtitle?.font_family;
    const nextMain = replacements.get(main?.trim());
    const nextExtension = replacements.get(extension?.trim());
    const history = MaweHistory.captureSegmentsRecord('替换工程字体');
    history.fontPreview = MaweHistory.snapshotPreviewState();
    let changed = Boolean(nextMain || nextExtension);
    const styles = new Map((MaweBoot.DATA.styles || []).map(style => [style.id, style]));
    const styleReplacements = new Map();
    for (const track of MaweBoot.DATA.tracks || []) {
      const style = track.style?.font_default === true ? null : styles.get(track.style?.style_id);
      const replacement = replacements.get(style?.fontName?.trim());
      if (replacement) { styleReplacements.set(style, replacement); track.style.forked = true; changed = true; }
      for (const segment of track.segments || []) {
        const next = replacements.get(segment.assStyle?.fontName?.trim());
        if (next) { segment.assStyle.fontName = next; changed = true; }
      }
    }
    for (const [style, replacement] of styleReplacements) style.fontName = replacement;
    if (!changed) return;
    if (nextMain) MaweAppearance.setSubtitleAppearance({ font_family: nextMain });
    if (nextExtension) MaweAppearance.setExtensionSubtitleAppearance({ font_family: nextExtension });
    MaweHistory.commitRecord(history);
    MaweState.markProjectDirty();
    window.MaweAssManagerWiring?.syncAssStyleManager?.();
    window.MaweAssCanvas?.clearCaches?.();
    window.MaweAssFrame?.notifyProjectChanged?.();
    MawePlaybackLoop.update();
    MaweProjectSave.updateProjectDirtyIndicator();
    MaweServerSave.scheduleAutoSave();
  }

  function show(result, generation) {
    close();
    const aliases = global.MaweAssFontAliases;
    panel = document.createElement('section');
    panel.className = 'project-font-check';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', '工程字体检查');
    panel.innerHTML = '<h2>工程字体检查</h2><div class="project-font-check-content"></div>'
      + '<div class="project-font-check-actions"><button type="button" data-action="retry">重新检查</button>'
      + '<button type="button" data-action="continue">暂时继续</button></div>';
    const content = panel.querySelector('.project-font-check-content');
    function paragraph(text) {
      const p = document.createElement('p');
      p.textContent = text;
      content.append(p);
    }
    function list(items) {
      const ul = document.createElement('ul');
      for (const item of items) {
        const li = document.createElement('li');
        li.textContent = item;
        ul.append(li);
      }
      content.append(ul);
    }
    if (!result.available) {
      paragraph(MaweBoot.SERVER_CONFIG?.assFontAliasesUrl
        ? '暂时无法检查本机字体。请检查本地编辑器服务后重试；当前字体可能回退。'
        : '便携模式无法检查本机字体。请在本地编辑器服务中打开工程后重查；当前字体可能回退。');
      panel.querySelector('[data-action="retry"]').hidden = !MaweBoot.SERVER_CONFIG?.assFontAliasesUrl;
    } else {
      if (result.legacy.length) {
        paragraph('发现旧字体名。确认替换后请检查字幕效果；不符合预期时可以撤销：');
        list(result.legacy.map(({ from, to }) => `${from} → ${to}`));
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '确认并替换旧名称';
        button.addEventListener('click', () => {
          if (generation !== MaweState.projectLoadGeneration) return;
          applyReplacements(new Map(result.legacy.map(({ from, to }) => [from, to])));
          void check({ generation });
        });
        content.append(button);
      }
      if (result.missing.length) {
        paragraph('本机未匹配到以下工程字体。继续编辑时，预览或渲染可能回退到其他字体：');
        list(result.missing.map(name => previewFamilies[name] ? `${name}（${previewFamilies[name].join(' / ')}）` : name));
        paragraph('安装字体后可重新检查；也可以将这些名称统一替换为一个本机字体。');
        const input = document.createElement('input');
        input.type = 'text';
        input.setAttribute('aria-label', '替换为本机字体');
        input.placeholder = '输入本机字体名称';
        input.setAttribute('list', 'project-font-check-options');
        const options = document.createElement('datalist');
        options.id = 'project-font-check-options';
        for (const name of [...new Set(aliases.entries().map(entry => entry.canonical))]) {
          const option = document.createElement('option');
          option.value = name;
          options.append(option);
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '统一替换缺失字体';
        const error = document.createElement('p');
        error.setAttribute('role', 'status');
        button.addEventListener('click', () => {
          if (generation !== MaweState.projectLoadGeneration) return;
          const target = aliases.canonicalFor(input.value);
          if (!target) { error.textContent = '请选择已匹配的本机字体。'; return; }
          applyReplacements(new Map(result.missing.map(name => [name, target])));
          void check({ generation });
        });
        content.append(input, options, button, error);
      }
    }
    panel.querySelector('[data-action="retry"]').addEventListener('click', event => {
      event.currentTarget.disabled = true;
      event.currentTarget.textContent = '正在检查…';
      void check({ generation, refresh: true });
    });
    panel.querySelector('[data-action="continue"]').addEventListener('click', () => {
      serial += 1;
      close();
    });
    document.body.append(panel);
  }

  async function check({ generation = MaweState.projectLoadGeneration, refresh = false } = {}) {
    const ticket = ++serial;
    if (!projectNames().length) { close(); return; }
    const aliases = global.MaweAssFontAliases;
    const available = await aliases.reload({ refresh });
    if (ticket !== serial || generation !== MaweState.projectLoadGeneration) return;
    const names = projectNames();
    if (!names.length) { close(); return; }
    if (!available) { show({ available: false }, generation); return; }
    const legacy = [];
    const missing = [];
    for (const name of names) {
      if (previewFamilies[name]) {
        if (!previewFamilies[name].some(candidate => aliases.canonicalFor(candidate))) missing.push(name);
        continue;
      }
      const canonical = aliases.canonicalFor(name);
      if (!canonical) missing.push(name);
      else if (aliases.isLegacy(name) && canonical !== name) legacy.push({ from: name, to: canonical });
    }
    if (legacy.length || missing.length) show({ available: true, legacy, missing }, generation);
    else close();
  }

  function schedule() {
    const generation = MaweState.projectLoadGeneration;
    const ticket = ++serial;
    close();
    // Let opening and the first paint complete before looking at font results.
    setTimeout(() => {
      if (ticket === serial && generation === MaweState.projectLoadGeneration) void check({ generation });
    }, 0);
  }
  MaweState.observeProjectLoad(() => { serial += 1; close(); });
  global.MaweProjectFontCheck = Object.freeze({ schedule });
})(typeof window !== 'undefined' ? window : globalThis);
