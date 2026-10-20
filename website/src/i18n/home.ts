// 首页中英文案。结构两种语言一致；新增文案时两边同步。
// 图片路径相对 public/，由组件经 sitePath() 拼接。

export type Lang = 'zh' | 'en';

interface Step { tag: string; title: string; body: string; meta?: string; img: string; alt: string }
interface Demo { title: string; body: string; img?: string; video?: string; poster?: string; alt: string }
interface Qa { q: string; a: string }

export interface HomeCopy {
  htmlLang: string;
  title: string;
  description: string;
  nav: { features: string; editor: string; faq: string; docs: string; releases: string };
  langSwitch: { label: string; href: string; aria: string };
  themeAria: string;
  hero: { line1: string; accent: string; line2: string; lede: string[]; download: string; github: string; editorAlt: string; launcherAlt: string };
  featuresTitle: string[];
  steps: Step[];
  facts: {
    gpu: { title: string; body: string };
    local: { title: string; tag: string; body: string; models: string[] };
    editor: { title: string; body: string; more: string };
  };
  editor: { titleA: string; accent: string; titleB: string; lede: string; mainAlt: string; demos: Demo[]; carouselAria: string };
  faqTitle: string;
  faq: Qa[];
  download: {
    title: string;
    main: { title: string; body: string; button: string; links: { label: string; href: string }[] };
    gh: { body: string; stars: string };
    mascotAlt: string;
  };
  footer: { links: { label: string; href: string }[]; note: string; tagline: string };
}

const repo = 'https://github.com/Moyf/moys-asr-workflow';
export const links = {
  repo,
  releases: `${repo}/releases/latest`,
  changelog: 'releases/',
  issues: `${repo}/issues`,
  // 教程视频地址待定，暂指向 README 中的速览视频
  video: 'https://www.bilibili.com/video/BV1hXum6yELT',
  qq: 'https://qm.qq.com/q/4YtxZIpzxC',
};

const models = ['Qwen3-ASR', 'SenseVoice', 'Paraformer', 'FireRedASR', 'Faster-Whisper'];

export const copy: Record<Lang, HomeCopy> = {
  zh: {
    htmlLang: 'zh-CN',
    title: "MAW - 阿墨的字幕工作台 | Moy's ASR Workflow",
    description: '从音视频转写，到波形校对与字幕交付。MAW 是开源、本地优先的字幕工作台，支持自选云端服务与实验性本地模型。',
    nav: { features: '功能', editor: '编辑器', faq: '常见问题', docs: '文档', releases: '更新记录' },
    langSwitch: { label: 'EN', href: 'en/', aria: 'Switch to English' },
    themeAria: '切换明暗主题',
    hero: {
      line1: '把声音变成',
      accent: '可继续编辑',
      line2: '的字幕',
      lede: ['从转写、波形校对，到字幕交付。', '开源、本地优先，保留工程继续修改。'],
      download: '免费下载',
      github: 'GitHub',
      editorAlt: 'MAWE 字幕编辑器：左侧视频与字幕列表，右侧多行波形与叠加字幕',
      launcherAlt: 'MAW Launcher：字幕已生成，可在编辑器中校对',
    },
    featuresTitle: ['字幕最费时间的部分，', '交给它。'],
    steps: [
      {
        tag: '01 转写', title: '拖进去，等它转完',
        body: '选好服务商，拖入视频或音频就能开始。多个文件自动排队，常用设置存成预设一键切换。',
        meta: '阿里云百炼 · Soniox · 豆包 · 腾讯云 · OpenAI 兼容接口',
        img: 'home/step-transcribe.webp', alt: 'Launcher 转写页：已选择媒体与识别设置',
      },
      {
        tag: '02 整理', title: '有文稿，就少改一遍',
        body: '用现成文稿自动修正错字，不需要 AI。也可以接上大模型做校对、断句和翻译，拿不准的地方会标出来让你确认。',
        img: 'home/step-cleanup.webp', alt: '自动后处理：按顺序配置固定替换、AI 校对、重新断句与翻译',
      },
      {
        tag: '03 交付', title: '改完就能用',
        body: '在编辑器里过一遍，导出 SRT、ASS 或双语字幕；也能直接烧录进视频，或把剪好的时间线交给剪辑软件。',
        img: 'home/step-deliver.webp', alt: 'ASS 样式库：调整字体、描边与位置并实时预览',
      },
    ],
    facts: {
      gpu: { title: '不需要显卡', body: '识别交给云端服务，普通笔记本就够用。费用按你选的服务商计算。' },
      local: { title: '同样支持本地模型', tag: '实验性', body: '有显卡、或者不想上传？在本机跑开源模型。', models },
      editor: { title: '自带好用的字幕编辑器', body: '不用再导进别的软件慢慢对轴。转写完直接打开，改完直接导出。', more: '看看编辑器 ↓' },
    },
    editor: {
      titleA: '听得见声音，', accent: '看得清细节', titleB: '',
      lede: '把波形、字幕与时间放在一起。边听边改，让每一句落在合适的位置。',
      mainAlt: 'MAWE 编辑器：多行波形与频谱，字幕块按时间排布',
      carouselAria: '选择编辑器功能',
      demos: [
        { title: '多行波形', body: '长音频一屏看完，点哪播哪', img: 'home/demo-waveform.webp', alt: '多行波形与播放头' },
        { title: '双语与多轨', body: '主副字幕上下对照编辑', img: 'home/demo-bilingual.webp', alt: '双语字幕双列编辑' },
        { title: '说话人颜色', body: '谁在说话，一眼看清', img: 'home/demo-speaker.webp', alt: '按说话人着色的字幕预览' },
        { title: '按字拆分', body: '沿着字的边界，一刀切开', img: 'home/demo-split.webp', alt: '拆分位置预览' },
        { title: '像玩游戏一样编辑', body: 'WASD 切换字幕，键盘流到底', img: 'home/demo-keyboard.webp', alt: '快速上手：WASD 切换字幕' },
        { title: '可逆空隙移除', body: '先听节奏再决定，随时恢复', img: 'home/demo-gaps.webp', alt: '空隙移除：在波形上查看保留与移除的区间' },
      ],
    },
    faqTitle: '常见问题',
    faq: [
      { q: '要花钱吗？', a: 'MAW 免费开源。云端识别按服务商价格计费，本地模型不收费。' },
      { q: '需要显卡吗？', a: '云端识别不需要。本地模型建议有独立显卡。' },
      { q: '是在线网站吗？', a: 'MAW 下载后在本机运行，编辑与保存留在本机。云端转写会把音频发送给你选择的服务商；使用 LLM 整理时，相应字幕与文稿也会发送给所选服务。' },
      { q: '能导出什么？', a: 'SRT、ASS、双语字幕、烧录视频，以及给剪辑软件（PR、达芬奇）用的时间线。' },
    ],
    download: {
      title: '开始做下一期字幕',
      main: {
        title: '下载 MAW',
        body: '选择与你的系统和架构对应的安装包。第一次可以只转前两分钟，试试效果。',
        button: '下载最新版',
        links: [
          { label: '上手指南', href: 'docs/getting-started/' },
          { label: '更新日志', href: links.changelog },
          { label: '教程视频', href: links.video },
        ],
      },
      gh: { body: '开源在 GitHub。觉得好用，点个 Star 让更多人看到。', stars: 'Stars' },
      mascotAlt: 'MAW 吉祥物阿墨',
    },
    footer: {
      links: [
        { label: '文档', href: 'docs/' },
        { label: '更新日志', href: links.changelog },
        { label: '反馈问题', href: links.issues },
        { label: 'QQ 群', href: links.qq },
      ],
      note: '开源许可 AGPL-3.0 · 识别与 AI 结果仍需人工检查',
      tagline: "阿墨的字幕工作台",
    },
  },

  en: {
    htmlLang: 'en',
    title: "MAW - Moy's ASR Workflow",
    description: 'From transcription to waveform editing and subtitle delivery. An open-source, local-first workbench with your choice of cloud service and experimental local models.',
    nav: { features: 'Features', editor: 'Editor', faq: 'FAQ', docs: 'Docs', releases: 'Updates' },
    langSwitch: { label: '中文', href: '', aria: '切换到中文' },
    themeAria: 'Toggle light / dark theme',
    hero: {
      line1: 'Turn speech into',
      accent: 'editable',
      line2: 'subtitles',
      lede: ['From transcription to waveform editing and subtitle delivery.', 'An open-source workbench. Keep your project, pick up where you left off.'],
      download: 'Download free',
      github: 'GitHub',
      editorAlt: 'MAWE subtitle editor: video and cue list on the left, multi-row waveform with overlay subtitles on the right',
      launcherAlt: 'MAW Launcher: subtitles generated, ready to review in the editor',
    },
    featuresTitle: ['The slow part of subtitling,', 'handled.'],
    steps: [
      {
        tag: '01 Transcribe', title: 'Drop it in, let it run',
        body: 'Pick a provider and drop in a video or audio file. Multiple files queue up automatically, and your usual settings live in one-click presets.',
        meta: 'Alibaba Bailian · Soniox · Doubao · Tencent Cloud · OpenAI-compatible APIs',
        img: 'home/step-transcribe.webp', alt: 'Launcher transcribe page with a media file and recognition settings',
      },
      {
        tag: '02 Clean up', title: 'Have a script? Skip a pass',
        body: 'Match against your script to fix typos locally, no AI needed. Or chain an LLM to proofread, re-segment and translate; anything uncertain gets flagged for you.',
        img: 'home/step-cleanup.webp', alt: 'Post-processing steps: replace, AI proofread, re-segment and translate',
      },
      {
        tag: '03 Deliver', title: 'Done means ready to ship',
        body: 'Give it one pass in the editor, then export SRT, ASS or bilingual subtitles. Burn them into the video, or hand an edited timeline to your NLE.',
        img: 'home/step-deliver.webp', alt: 'ASS style library with live preview',
      },
    ],
    facts: {
      gpu: { title: 'No GPU required', body: 'Recognition runs on the cloud service you choose, so any laptop will do. You pay that provider directly.' },
      local: { title: 'Local models, too', tag: 'Experimental', body: 'Have a GPU, or prefer not to upload? Run open models on your own machine.', models },
      editor: { title: 'A subtitle editor that’s a joy to use', body: 'No more importing into another app to fix timing. Open it right after transcription, export when you’re done.', more: 'See the editor ↓' },
    },
    editor: {
      titleA: 'Hear the sound. ', accent: 'See the detail.', titleB: '',
      lede: 'Waveform, text and timing in one place. Listen, refine, and give each line room to land.',
      mainAlt: 'MAWE editor: multi-row waveform with spectrogram and subtitle blocks on the timeline',
      carouselAria: 'Choose an editor feature',
      demos: [
        { title: 'Multi-row waveform', body: 'See a long take at a glance; click to play', img: 'home/demo-waveform.webp', alt: 'Multi-row waveform with playhead' },
        { title: 'Bilingual tracks', body: 'Edit primary and secondary side by side', img: 'home/demo-bilingual.webp', alt: 'Bilingual subtitles in two columns' },
        { title: 'Speaker colors', body: 'Know who is talking at a glance', img: 'home/demo-speaker.webp', alt: 'Subtitle preview colored by speaker' },
        { title: 'Split by word', body: 'Cut exactly on a word boundary', img: 'home/demo-split.webp', alt: 'Split position preview' },
        { title: 'Edit like a game', body: 'WASD to move between cues', img: 'home/demo-keyboard.webp', alt: 'Quick start: WASD navigation' },
        { title: 'Reversible gap removal', body: 'Hear the new pace first; undo anytime', img: 'home/demo-gaps.webp', alt: 'Gap removal: retained and removed ranges on the waveform' },
      ],
    },
    faqTitle: 'FAQ',
    faq: [
      { q: 'Does it cost anything?', a: 'MAW is free and open source. Cloud recognition is billed by your provider; local models are free.' },
      { q: 'Do I need a GPU?', a: 'Not for cloud recognition. A dedicated GPU is recommended for local models.' },
      { q: 'Is it a website?', a: 'Download MAW and run it on your computer. Editing and saving stay local. Cloud transcription sends audio to your chosen provider; optional LLM processing sends the relevant subtitle and script text to that service.' },
      { q: 'What can I export?', a: 'SRT, ASS, bilingual subtitles, burned-in video, and timelines for Premiere Pro or DaVinci Resolve.' },
    ],
    download: {
      title: 'Start your next subtitles',
      main: {
        title: 'Download MAW',
        body: 'Choose a package for your system and architecture. Try the first two minutes on your first run.',
        button: 'Download latest',
        links: [
          { label: 'Getting started', href: 'docs/getting-started/' },
          { label: 'Changelog', href: links.changelog },
          { label: 'Tutorial video', href: links.video },
        ],
      },
      gh: { body: 'Open source on GitHub. If it helps you, a star helps others find it.', stars: 'Stars' },
      mascotAlt: 'MAW mascot',
    },
    footer: {
      links: [
        { label: 'Docs (Chinese)', href: 'docs/' },
        { label: 'Changelog', href: links.changelog },
        { label: 'Report an issue', href: links.issues },
      ],
      note: 'Licensed AGPL-3.0 · Always review recognition and AI output',
      tagline: "Moy's ASR Workflow",
    },
  },
};
