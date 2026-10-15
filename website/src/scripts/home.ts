// 官网首页交互：主题、入场、滚动叙事、Hero 舞台、Star 数、走马灯悬停、背景微粒。
// 由 Home.astro 以 <script> 引入（Astro 打包为模块，延迟执行）。
export {};

const root = document.documentElement;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const THEME_KEY = 'maw-site-theme';

// —— 主题：首屏内联脚本已设初值，这里只处理切换 ——
document.querySelector('[data-theme-toggle]')?.addEventListener('click', () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, root.dataset.theme);
});

// —— 入场 ——
const revealIo = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) { e.target.classList.add('is-in'); revealIo.unobserve(e.target); }
  }
}, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
document.querySelectorAll('.reveal').forEach((el) => revealIo.observe(el));
root.classList.add('reveal-ready');

// —— 功能区：文字段落经过视口中线时切换左侧画面 ——
const steps = [...document.querySelectorAll('.step')];
const storyFrames = [...document.querySelectorAll('.story-frames > *')];
const storyDots = [...document.querySelectorAll('.story-dots i')];
const setStep = (i: number) => {
  for (const list of [steps, storyFrames, storyDots]) list.forEach((el, k) => el.classList.toggle('is-on', k === i));
};
const stepIo = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) setStep(steps.indexOf(e.target));
}, { rootMargin: '-45% 0px -45% 0px' });
steps.forEach((s) => stepIo.observe(s));
setStep(0);

// —— 导航高亮 ——
const navLinks = [...document.querySelectorAll<HTMLAnchorElement>('.nav a[href^="#"]')];
const navIo = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    navLinks.forEach((a) => a.classList.toggle('is-active', a.getAttribute('href') === `#${e.target.id}`));
  }
}, { rootMargin: '-40% 0px -55% 0px' });
navLinks.forEach((a) => {
  const target = document.querySelector(a.getAttribute('href') || '');
  if (target) navIo.observe(target);
});

// —— GitHub Star 数：缓存 1 小时，失败时保留占位 ——
const starEls = document.querySelectorAll('[data-stars]');
const STAR_KEY = 'maw-site-stars';
const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const paint = (n: number) => starEls.forEach((el) => { el.textContent = fmt(n); });
try {
  const cached = JSON.parse(localStorage.getItem(STAR_KEY) || 'null');
  if (cached && Date.now() - cached.t < 3600e3) {
    paint(cached.n);
  } else {
    fetch('https://api.github.com/repos/Moyf/moys-asr-workflow')
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        paint(d.stargazers_count);
        localStorage.setItem(STAR_KEY, JSON.stringify({ n: d.stargazers_count, t: Date.now() }));
      })
      .catch(() => {});
  }
} catch { /* localStorage 不可用时保留占位 */ }

// —— 演示走马灯：悬停的卡放大、相邻卡微放大；只播放悬停卡里的视频 ——
//    视频用 data-src 懒加载，首次悬停才赋 src；离开时暂停并回到开头。图片与占位卡只放大不播放。
document.querySelectorAll('.marquee-group').forEach((group) => {
  const cards = [...group.querySelectorAll<HTMLElement>('.demo')];
  const clear = () => cards.forEach((c) => c.classList.remove('is-hot', 'is-near', 'is-playing'));
  cards.forEach((card, i) => {
    const video = card.querySelector('video');
    const enter = () => {
      clear();
      card.classList.add('is-hot');
      cards[i - 1]?.classList.add('is-near');
      cards[i + 1]?.classList.add('is-near');
      if (!video || reduceMotion) return;
      if (!video.src && video.dataset.src) video.src = video.dataset.src;
      video.play().then(() => card.classList.add('is-playing')).catch(() => {});
    };
    const leave = () => {
      clear();
      if (video) { video.pause(); video.currentTime = 0; }
    };
    card.tabIndex = card.closest('[aria-hidden="true"]') ? -1 : 0;
    card.addEventListener('pointerenter', enter);
    card.addEventListener('pointerleave', leave);
    card.addEventListener('focus', enter);
    card.addEventListener('blur', leave);
  });
});

// —— 进度条、页头描边、Hero 舞台：滚动驱动 ——
const header = document.querySelector('.site-header');
const stage = document.querySelector<HTMLElement>('.stage');
let ticking = false;
const onScroll = () => {
  const max = root.scrollHeight - innerHeight;
  root.style.setProperty('--p', max > 0 ? (scrollY / max).toFixed(4) : '0');
  header?.classList.toggle('is-scrolled', scrollY > 8);
  if (stage) {
    // 舞台顶部从视口底部进入到视口上 1/4 处：0 → 1
    const r = stage.getBoundingClientRect();
    const sy = reduceMotion ? 1 : Math.min(1, Math.max(0, (innerHeight - r.top) / (innerHeight * 0.75)));
    stage.style.setProperty('--sy', sy.toFixed(3));
  }
  ticking = false;
};
addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
addEventListener('resize', onScroll);
onScroll();

// —— 背景微粒：少量缓慢漂浮的点，个别是像波形一样轻轻起伏的短竖线 ——
//    只在卡片之间的空白处可见；页面隐藏时停帧，减少动态偏好下只画静帧。
const canvas = document.createElement('canvas');
canvas.className = 'bg-particles';
canvas.setAttribute('aria-hidden', 'true');
document.body.prepend(canvas);
const ctx = canvas.getContext('2d');
interface Dot { x: number; y: number; r: number; vx: number; vy: number; ph: number; bar: boolean; warm: boolean }
let W = 0;
let H = 0;
let dots: Dot[] = [];
let colors = { a: '#c84545', b: '#a1a1a8' };
const readColors = () => {
  const cs = getComputedStyle(root);
  colors = { a: cs.getPropertyValue('--accent').trim(), b: cs.getPropertyValue('--text-4').trim() };
};
const seed = () => {
  if (!ctx) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  W = innerWidth;
  H = innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const n = Math.min(46, Math.round((W * H) / 30000));
  dots = Array.from({ length: n }, () => ({
    x: Math.random() * W,
    y: Math.random() * H,
    r: 0.8 + Math.random() * 1.4,
    vx: (Math.random() - 0.5) * 0.08,
    vy: -0.04 - Math.random() * 0.1,
    ph: Math.random() * Math.PI * 2,
    bar: Math.random() < 0.22,
    warm: Math.random() < 0.35,
  }));
};
const draw = (t: number) => {
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  const dark = root.dataset.theme === 'dark';
  for (const d of dots) {
    const tw = 0.5 + 0.5 * Math.sin(t / 1600 + d.ph);
    ctx.globalAlpha = (dark ? 0.16 : 0.2) + tw * (dark ? 0.22 : 0.18);
    ctx.fillStyle = d.warm ? colors.a : colors.b;
    if (d.bar) {
      const h = 4 + tw * 9;
      ctx.fillRect(d.x - 1, d.y - h / 2, 2, h);
    } else {
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
};
const move = (dt: number) => {
  for (const d of dots) {
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    if (d.y < -12) { d.y = H + 12; d.x = Math.random() * W; }
    if (d.x < -12) d.x = W + 12;
    if (d.x > W + 12) d.x = -12;
  }
};
readColors();
seed();
new MutationObserver(() => { readColors(); if (reduceMotion) draw(0); }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
addEventListener('resize', () => { seed(); if (reduceMotion) draw(0); });
if (reduceMotion) {
  draw(0);
} else {
  let last = performance.now();
  const loop = (t: number) => {
    const dt = Math.min(64, t - last) / 16.7;
    last = t;
    if (!document.hidden) { move(dt); draw(t); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
