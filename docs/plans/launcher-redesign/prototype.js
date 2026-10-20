(function () {
  var html = document.documentElement;
  var state = 'empty';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---------- 页面路由 ---------- */
  function go(page, settab) {
    $$('.nav-item').forEach(function (b) { b.classList.toggle('active', b.dataset.page === page); });
    $$('.page').forEach(function (p) { p.classList.toggle('on', p.id === 'page-' + page); });
    if (settab) pickSet(settab);
    closeSheet();
  }
  $$('.nav-item[data-page]').forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.page); }); });
  $('#helpBtn').addEventListener('click', function (e) { e.stopPropagation(); $('#helpMenu').classList.toggle('hidden'); });
  document.addEventListener('click', function (e) { if (!e.target.closest('#helpMenu')) $('#helpMenu').classList.add('hidden'); });
  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-goto]');
    if (!a) return;
    e.preventDefault();
    go(a.dataset.goto, a.dataset.settab);
  });

  /* ---------- 转写页状态 ---------- */
  function apply() {
    $$('#page-transcribe [data-show]').forEach(function (el) {
      el.classList.toggle('hidden', el.dataset.show.split(/\s+/).indexOf(state) === -1);
    });
    $('#startBtn').disabled = state === 'empty' || state === 'nokey';
    $('#startText').textContent = state === 'done' ? '重新生成' : '开始生成';
    $('#statusText').textContent = state === 'nokey' ? '先配置 API Key，再选择媒体文件' : '选择媒体文件后即可开始';
    var s1 = $('#step1');
    var done = ['ready', 'running', 'done'].indexOf(state) !== -1;
    s1.classList.toggle('done', done);
    s1.innerHTML = done ? '&#10003;' : '1';
    $('#keyMask').textContent = state === 'nokey' ? '粘贴 API Key' : 'sk-••••••••••••••••3f9a';
    if (state !== 'running') $('#logCard').classList.add('hidden');
    $$('.proto-bar [data-state]').forEach(function (b) { b.classList.toggle('on', b.dataset.state === state); });
  }
  $$('.proto-bar [data-state]').forEach(function (b) {
    b.addEventListener('click', function () { state = b.dataset.state; go('transcribe'); apply(); });
  });
  $('#logBtn').addEventListener('click', function () { $('#logCard').classList.toggle('hidden'); });
  $('#toggleAsr').addEventListener('click', function () {
    var ex = $('#asrExpand');
    ex.classList.toggle('open');
    this.firstElementChild.textContent = ex.classList.contains('open') ? '收起' : '展开全部设置';
  });

  /* ---------- 主题 ---------- */
  function setTheme(t) {
    html.setAttribute('data-theme', t === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t);
    $$('[data-theme-pick]').forEach(function (b) { b.classList.toggle('on', b.dataset.themePick === t); });
  }
  function toggleTheme() { setTheme(html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); }
  $('#themeBtn').addEventListener('click', toggleTheme);
  $('.theme-toggle').addEventListener('click', toggleTheme);
  $$('[data-theme-pick]').forEach(function (b) { b.addEventListener('click', function () { setTheme(b.dataset.themePick); }); });

  /* ---------- 服务商切换：识别设置展开区随服务商变化 ---------- */
  var PROV = {
    dashscope: { name: '阿里云百炼（推荐 / 千问）', model: 'qwen-audio-3.0-asr', hint: '支持即时热词、上下文与说话人分离', chips: ['阿里云百炼', 'qwen-audio-3.0-asr', '语言：自动', '热词 12 个'], key: '在 <a href="#">千问 AI 平台 ↗</a> 获取 · 参考价约 ¥0.79 / 小时 · 海外用户请在 <a href="#" data-goto="settings" data-settab="runtime">设置 → 运行环境</a> 选择地域', lang: '自动识别', langHint: '可多选；不选时自动识别。更多语种在 <a href="#" data-goto="settings">设置</a> 中开启。' },
    soniox:    { name: 'Soniox', model: 'stt-async-v5（上下文）', hint: '异步文件转写，支持上下文与翻译术语', chips: ['Soniox', 'stt-async-v5', '语言：中文 + 英文', '上下文 2 项'], key: '在 <a href="#">Soniox 控制台 ↗</a> 获取 · 参考价约 $0.10 / 小时', lang: '中文、英文', langHint: '可多选，作为语言提示。' },
    openai:    { name: 'OpenAI / 兼容接口', model: 'gpt-transcribe', hint: '推荐的文件转写模型，支持 Prompt 与 Keywords', chips: ['OpenAI', 'gpt-transcribe', '语言：自动'], key: '在 <a href="#">OpenAI</a> 或 <a href="#">OpenRouter ↗</a> 获取 · 参考价约 $0.27 / 小时', lang: '自动识别', langHint: '单选；不选时自动识别。' },
    doubao:    { name: '豆包（火山引擎）', model: '录音文件识别大模型', hint: '媒体直传火山引擎；单文件 ≤ 25 MB、≤ 120 分钟', chips: ['豆包', '录音文件识别', '语言：自动'], key: '在 <a href="#">火山引擎控制台 ↗</a> 获取', lang: '自动识别', langHint: '' },
    tencent:   { name: '腾讯云', model: '录音文件识别大模型 2.0', hint: '16k 中英粤', chips: ['腾讯云', '大模型 2.0', '语言：中英'], key: '', lang: '中文 + 英文', langHint: '' },
    local:     { name: '本地模型（实验性）', model: 'Qwen3-ASR-1.7B', hint: '在本机运行，不上传音频', chips: ['本地模型', 'Qwen3-ASR-1.7B', 'CUDA'], key: '', lang: '自动识别', langHint: '' },
    firered:   { name: '本地模型（实验性）', model: 'FireRedASR2', hint: '中英与方言，CPU 可用，字级时间码', chips: ['本地模型', 'FireRedASR2', 'CPU', 'ct-punc'], key: '', lang: '中文', langHint: '' },
    bcut:      { name: '必剪 ASR（免 Key）', model: 'bcut-asr', hint: '毫秒级逐字时间码，仅中文', chips: ['必剪', '免 Key', '仅中文'], key: '', lang: '中文', langHint: '该服务只支持中文。' }
  };
  var noKeyNeeded = ['local', 'firered', 'bcut'];
  function setProv(p) {
    var d = PROV[p];
    $('#provName').textContent = d.name;
    $('#provModel').textContent = d.model;
    $('#provModelHint').textContent = d.hint;
    $('#provKeyHint').innerHTML = d.key;
    $('#provLang').textContent = d.lang;
    $('#provLangHint').innerHTML = d.langHint;
    $('#provLangHint').classList.toggle('hidden', !d.langHint);
    $$('#asrExpand [data-prov]').forEach(function (el) {
      el.classList.toggle('hidden', el.dataset.prov.split(/\s+/).indexOf(p) === -1);
    });
    var sum = $('#asrSummary');
    $$('.chip.dyn', sum).forEach(function (c) { c.remove(); });
    var anchor = $('[data-keychip]', sum);
    d.chips.forEach(function (t) {
      var c = document.createElement('span');
      c.className = 'chip dyn';
      c.textContent = t;
      sum.insertBefore(c, anchor);
    });
    $$('[data-keychip]', sum).forEach(function (c) { c.classList.toggle('prov-off', noKeyNeeded.indexOf(p) !== -1); });
    $$('.proto-bar [data-prov-pick]').forEach(function (b) { b.classList.toggle('on', b.dataset.provPick === p); });
  }
  $$('.proto-bar [data-prov-pick]').forEach(function (b) {
    b.addEventListener('click', function () {
      go('transcribe');
      var ex = $('#asrExpand');
      if (!ex.classList.contains('open')) $('#toggleAsr').click();
      setProv(b.dataset.provPick);
    });
  });

  /* ---------- 自动处理步骤（与工具箱一一对应） ---------- */
  var STEPS = ['match', 'cleanup', 'replace', 'proofread', 'resegment', 'ocr', 'translate', 'burn'];
  var TITLE = { match: '文稿匹配', cleanup: 'AI 口播整理', replace: '固定替换', proofread: 'AI 校对', resegment: '重新断句', ocr: 'OCR 去重', translate: '翻译', burn: '烧录字幕' };
  // 默认只把常用步骤显示在转写页；其余在工具箱里按需打开
  var pinned = { replace: true, proofread: true, resegment: true, translate: true };
  function visibleSteps() { return STEPS.filter(function (k) { return pinned[k]; }); }
  function stepRow(key) { return $('#page-transcribe .pstep[data-step="' + key + '"]'); }

  function renderPins() {
    var vis = visibleSteps();
    STEPS.forEach(function (k) {
      var row = stepRow(k);
      row.classList.toggle('hidden', !pinned[k]);
      var n = vis.indexOf(k);
      if (n !== -1) $('.num', row).textContent = n + 1;
      var dot = $('[data-pin-dot="' + k + '"]');
      if (dot) dot.classList.toggle('on', !!pinned[k]);
      var rail = $('#sheetTabs [data-cfg="' + k + '"]');
      rail.classList.toggle('hidden', !pinned[k]);
      if (n !== -1) $('.n', rail).textContent = n + 1;
      $$('[data-pin-sw="' + k + '"]').forEach(function (s) { s.classList.toggle('on', !!pinned[k]); });
    });
    var hidden = STEPS.length - vis.length;
    $('#pipeHidden').textContent = hidden ? '另有 ' + hidden + ' 个步骤未显示（在工具箱中开启）' : '全部步骤都已显示';
    var enabled = vis.filter(function (k) { return $('.sw', stepRow(k)).classList.contains('on'); }).length;
    $('#pipeMeta').textContent = '按顺序执行 · 已启用 ' + enabled + ' 项';
  }
  function setPin(k, on) {
    pinned[k] = on;
    if (!on) syncStep(k, false); // 不显示的步骤不会被执行
    renderPins();
  }

  /* ---------- 工具箱 ---------- */
  var runText = { match: '匹配文稿', cleanup: '开始整理', proofread: '开始校对', resegment: '开始断句', translate: '开始翻译', custom: '开始处理', replace: '执行替换', ocr: '执行 OCR 去重', timestamps: '生成时间码', burn: '烧录字幕', alignment: '启动并打开口播对齐', extract: '提取音频', waveform: '生成波形并打开编辑器' };
  // 共享输入：字幕处理类用「处理文件」，媒体类用「媒体文件」；口播对齐、生成时间码自带输入
  var subtitleInput = ['match', 'replace', 'ocr', 'cleanup', 'proofread', 'resegment', 'translate', 'custom'];
  var mediaInput = ['burn', 'extract', 'waveform'];
  function pickTool(t) {
    $$('#tbNav button').forEach(function (b) { b.classList.toggle('on', b.dataset.tool === t); });
    $$('#toolPanes .tool-pane').forEach(function (p) { p.classList.toggle('on', p.dataset.pane === t); });
    $('#tbRunText').textContent = runText[t];
    $('#tbInput').classList.toggle('hidden', subtitleInput.indexOf(t) === -1);
    $('#tbMedia').classList.toggle('hidden', mediaInput.indexOf(t) === -1);
    // 「输出：工程 + SRT」只对字幕处理有意义（对应 toolboxOutputField）；媒体工具始终生成新文件
    $('#tbOut').classList.toggle('hidden', subtitleInput.indexOf(t) === -1);
    $('#tbOutLbl').classList.toggle('hidden', subtitleInput.indexOf(t) === -1);
  }
  $$('#tbNav button').forEach(function (b) { b.addEventListener('click', function () { pickTool(b.dataset.tool); }); });

  // AI 工具共用的尾部字段
  $$('.llm-common').forEach(function (slot) { slot.appendChild($('#llmCommonTpl').content.cloneNode(true)); });
  // 可加入流水线的工具：卡片底部放一行紧凑开关「可用于自动后处理」（不挤占卡片头）
  STEPS.forEach(function (k) {
    var pane = $('#toolPanes [data-pane="' + k + '"]');
    var pin = document.createElement('label');
    pin.className = 'pin-foot';
    pin.title = '打开后，这一步会出现在转写页的「自动后处理」中';
    pin.innerHTML = '<button class="sw sm" data-pin-sw="' + k + '"></button>可用于自动后处理';
    pane.appendChild(pin);
  });
  document.addEventListener('click', function (e) {
    var s = e.target.closest('[data-pin-sw]');
    if (s) setPin(s.dataset.pinSw, !s.classList.contains('on'));
  });
  $('#pipeManage').addEventListener('click', function () { go('toolbox'); pickTool('match'); });

  /* ---------- 设置 ---------- */
  function pickSet(s) {
    $$('#setNav button').forEach(function (b) { b.classList.toggle('on', b.dataset.set === s); });
    $$('[data-setpane]').forEach(function (p) { p.classList.toggle('on', p.dataset.setpane === s); });
  }
  $$('#setNav button').forEach(function (b) { b.addEventListener('click', function () { pickSet(b.dataset.set); }); });

  /* ---------- 配置抽屉：复用工具箱面板 ---------- */
  var current = 'replace';
  function openSheet(key) {
    current = key;
    var vis = visibleSteps();
    $('#sheetTitle').textContent = TITLE[key];
    $('#sheetIdx').textContent = (vis.indexOf(key) + 1) + ' / ' + vis.length;
    var src = $('#toolPanes [data-pane="' + key + '"]').cloneNode(true);
    src.classList.add('on');
    src.style.border = '0';
    src.style.boxShadow = 'none';
    src.style.padding = '0';
    $('.card-head', src).remove();
    var pin = $('.pin-foot', src);
    if (pin) pin.remove();
    var body = $('#sheetBody');
    body.innerHTML = '';
    body.appendChild(src);
    $$('#sheetTabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.cfg === key); });
    $('#sheetEnable').classList.toggle('on', $('.sw', stepRow(key)).classList.contains('on'));
    var oi = vis.indexOf(key);
    $('#sheetPrev').disabled = oi <= 0;
    $('#sheetNext').disabled = oi >= vis.length - 1;
    $('#sheet').classList.add('on');
    $('#scrim').classList.add('on');
    bindSwitches(body);
  }
  function closeSheet() { $('#sheet').classList.remove('on'); $('#scrim').classList.remove('on'); }
  function syncStep(key, on) {
    var row = stepRow(key);
    $('.sw', row).classList.toggle('on', on);
    row.classList.toggle('on', on);
    $('#sheetTabs [data-cfg="' + key + '"] .d').classList.toggle('off', !on);
    if ($('#pipeMeta')) {
      var enabled = visibleSteps().filter(function (k) { return $('.sw', stepRow(k)).classList.contains('on'); }).length;
      $('#pipeMeta').textContent = '按顺序执行 · 已启用 ' + enabled + ' 项';
    }
  }

  $$('.cfg-btn').forEach(function (b) { b.addEventListener('click', function () { openSheet(b.dataset.cfg); }); });
  $$('#sheetTabs button').forEach(function (b) { b.addEventListener('click', function () { openSheet(b.dataset.cfg); }); });
  $('#sheetClose').addEventListener('click', closeSheet);
  $('#sheetPrev').addEventListener('click', function () { var v = visibleSteps(), i = v.indexOf(current); if (i > 0) openSheet(v[i - 1]); });
  $('#sheetNext').addEventListener('click', function () { var v = visibleSteps(), i = v.indexOf(current); if (i < v.length - 1) openSheet(v[i + 1]); });
  $('#sheetDone').addEventListener('click', closeSheet);
  $('#scrim').addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
  $('#sheetOpenToolbox').addEventListener('click', function () { var k = current; go('toolbox'); pickTool(k); });
  $('#demoDrawer').addEventListener('click', function () { state = 'ready'; go('transcribe'); apply(); openSheet('proofread'); });
  $('#sheetEnable').addEventListener('click', function () {
    var on = !this.classList.contains('on');
    this.classList.toggle('on', on);
    syncStep(current, on);
  });
  renderPins();

  /* ---------- 通用小控件 ---------- */
  function bindSwitches(root) {
    $$('.sw', root).forEach(function (s) {
      if (s.id === 'sheetEnable' || s.dataset.bound) return;
      s.dataset.bound = '1';
      s.addEventListener('click', function () {
        s.classList.toggle('on');
        var row = s.closest('.pstep');
        if (row) syncStep($('.cfg-btn', row).dataset.cfg, s.classList.contains('on'));
      });
    });
  }
  bindSwitches(document);
  document.addEventListener('click', function (e) {
    var b = e.target.closest('.seg button');
    if (!b) return;
    $$('button', b.parentNode).forEach(function (x) { x.classList.toggle('on', x === b); });
  });

  // 截图 / 直达用：?page=&theme=&state=&sheet=&set=&tool=&collapsed=1
  var q = new URLSearchParams(location.search);
  if (q.toString()) html.classList.add('no-anim');
  if (q.get('theme')) setTheme(q.get('theme'));
  if (q.get('state')) state = q.get('state');
  apply();
  if (q.get('page')) go(q.get('page'));
  if (q.get('set')) pickSet(q.get('set'));
  if (q.get('tool')) pickTool(q.get('tool'));
  if (q.get('sheet')) openSheet(q.get('sheet'));
  if (q.get('collapsed')) $('#toggleAsr').click();
  setProv(q.get('prov') || 'dashscope');
  if (q.get('help')) $('#helpMenu').classList.remove('hidden');
})();
