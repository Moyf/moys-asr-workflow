// Progressive homepage interactions. No continuous timers or remote requests.
export {};
const root = document.documentElement;
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
root.classList.add('has-home-js');
const themeToggle = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
const updateThemeState = () => {
  themeToggle?.setAttribute('aria-pressed', String(root.dataset.theme === 'dark'));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', root.dataset.theme === 'dark' ? '#19211f' : '#f5f4ee');
};
themeToggle?.addEventListener('click', () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('maw-site-theme', root.dataset.theme); } catch { /* Theme still works without storage. */ }
  updateThemeState();
});
updateThemeState();
const menuToggle = document.querySelector<HTMLButtonElement>('[data-menu-toggle]');
const nav = document.querySelector<HTMLElement>('#main-nav');
const closeMenu = () => { menuToggle?.setAttribute('aria-expanded', 'false'); nav?.classList.remove('is-open'); };
menuToggle?.addEventListener('click', () => {
  const open = menuToggle.getAttribute('aria-expanded') !== 'true';
  menuToggle.setAttribute('aria-expanded', String(open));
  nav?.classList.toggle('is-open', open);
});
nav?.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menuToggle?.getAttribute('aria-expanded') === 'true') { closeMenu(); menuToggle.focus(); }
});
document.addEventListener('click', event => {
  if (event.target instanceof Node && !document.querySelector('.site-header')?.contains(event.target)) closeMenu();
});
matchMedia('(min-width: 761px)').addEventListener('change', closeMenu);
// Native buttons remain in the tab order; arrows are an additional convenience.
document.querySelectorAll<HTMLElement>('[data-switcher]').forEach(group => {
  const buttons = [...group.querySelectorAll<HTMLButtonElement>('[data-switch]')];
  const panels = [...group.querySelectorAll<HTMLElement>('[data-panel]')];
  const select = (index: number, animate = true) => {
    buttons.forEach((button, i) => { button.classList.toggle('is-active', index === i); button.setAttribute('aria-pressed', String(index === i)); });
    panels.forEach((panel, i) => {
      panel.hidden = index !== i;
      panel.classList.remove('panel-enter');
      if (index === i && animate && !motionQuery.matches && !root.classList.contains('is-shot')) panel.classList.add('panel-enter');
      if (index !== i) panel.querySelectorAll('video').forEach(video => video.pause());
    });
  };
  buttons.forEach((button, index) => {
    button.addEventListener('click', () => select(index));
    button.addEventListener('keydown', event => {
      let next: number;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % buttons.length;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = buttons.length - 1;
      else return;
      event.preventDefault(); buttons[next]?.focus(); select(next);
    });
  });
  select(0, false);
});
if ('IntersectionObserver' in window && !motionQuery.matches && !root.classList.contains('is-shot')) {
  const reveals = document.querySelectorAll<HTMLElement>('.reveal');
  reveals.forEach(element => { if (element.getBoundingClientRect().top < innerHeight) element.classList.add('is-in'); });
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('is-in'); observer.unobserve(entry.target); } });
  }, { threshold: 0.06 });
  reveals.forEach(element => observer.observe(element));
  root.classList.add('reveal-ready');
  motionQuery.addEventListener('change', event => { if (event.matches) { root.classList.remove('reveal-ready'); observer.disconnect(); } });
}
const header = document.querySelector('.site-header');
let scheduled = false;
const updateHeader = () => { header?.classList.toggle('is-scrolled', scrollY > 8); scheduled = false; };
addEventListener('scroll', () => { if (!scheduled) { scheduled = true; requestAnimationFrame(updateHeader); } }, { passive: true });
updateHeader();
