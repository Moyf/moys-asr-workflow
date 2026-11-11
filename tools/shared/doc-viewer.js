/* Read-only dialog UI. Supply a renderer and optional loader/resolver; no Markdown library dependency. */
(function () {
  'use strict';
  let nextId = 0;
  // One session owns background inert state, scroll locking and focus for every viewer.
  // Only the top native dialog remains in the browser top layer: a fallback viewer can
  // therefore sit above a native one too. Lower viewers stay open, but are inert.
  const modalStack = (function () {
    const entries = [], originalInert = new Map();
    let originalOverflow, originalOverflowPriority, originalFocus, updating = false;
    const top = () => entries.at(-1);
    function setInert(el, value) {
      if (!originalInert.has(el)) originalInert.set(el, el.inert);
      el.inert = value;
    }
    function usable(el, current) {
      return el?.isConnected && !el.closest('[inert]') && (!current || current.dialog.contains(el));
    }
    function focus(current, preferred) {
      if (!current) return;
      const target = usable(preferred, current) ? preferred
        : usable(current.lastFocus, current) ? current.lastFocus : current.closeButton;
      target.focus({preventScroll:true});
    }
    function sync() {
      updating = true;
      try {
        // Restore the initial values before deriving the current stack projection.
        originalInert.forEach((value, el) => {el.inert = value;});
        const current = top();
        if (!current) {
          document.documentElement.style.setProperty('overflow', originalOverflow, originalOverflowPriority);
          originalInert.clear();
          return;
        }
        document.documentElement.style.setProperty('overflow', 'hidden');
        for (const [index, entry] of entries.entries()) {
          if (entry !== current && entry.nativeModal) {
            entry.dialog.close(); entry.nativeModal = false; entry.dialog.setAttribute('open', '');
          }
          entry.dialog.setAttribute('data-stack-managed', '');
          entry.dialog.style.zIndex = String(10000 + index * 2);
          entry.mask.style.zIndex = String(9999 + index * 2);
          entry.mask.hidden = true;
          entry.dialog.setAttribute('aria-modal', String(entry === current));
        }
        const allowed = new Set([current.dialog, current.mask]);
        for (const node of [current.dialog, current.mask]) {
          for (let parent = node.parentElement; parent; parent = parent.parentElement) allowed.add(parent);
        }
        // Isolate siblings along the mount ancestry, without making the top viewer
        // or its ancestors inert. Precreated and newly-created viewer nodes work alike.
        function isolate(parent) {
          for (const child of parent.children) {
            setInert(child, !allowed.has(child));
            if (allowed.has(child) && child !== current.dialog && child !== current.mask) isolate(child);
          }
        }
        setInert(document.body, false); isolate(document.body);
        if (current.showModal) {
          if (!current.nativeModal) {
            current.dialog.removeAttribute('open'); current.showModal(); current.nativeModal = true;
          }
          current.dialog.removeAttribute('data-fallback');
        } else {
          current.dialog.setAttribute('open', ''); current.dialog.setAttribute('data-fallback', '');
          current.mask.hidden = false;
        }
      } finally {updating = false;}
    }
    function enter(entry, trigger) {
      if (!entries.length) {
        originalOverflow = document.documentElement.style.getPropertyValue('overflow');
        originalOverflowPriority = document.documentElement.style.getPropertyPriority('overflow');
        originalFocus = trigger;
      }
      const previous = top();
      if (previous?.dialog.contains(document.activeElement)) previous.lastFocus = document.activeElement;
      const index = entries.indexOf(entry);
      if (index !== -1) entries.splice(index, 1);
      else {
        entry.trigger = trigger;
        entry.showModal = typeof entry.dialog.showModal === 'function' ? entry.dialog.showModal.bind(entry.dialog) : null;
      }
      entries.push(entry); sync(); focus(entry, entry.closeButton);
    }
    function leave(entry) {
      const index = entries.indexOf(entry);
      if (index === -1) return;
      const wasTop = entry === top();
      // Closing a lower native/nonmodal dialog must not change the top focus.
      const topFocus = document.activeElement;
      entries.splice(index, 1);
      updating = true;
      try {
        if (entry.nativeModal) entry.dialog.close();
        else entry.dialog.removeAttribute('open');
        entry.nativeModal = false; entry.mask.hidden = true;
        entry.dialog.removeAttribute('data-fallback'); entry.dialog.removeAttribute('data-stack-managed');
        entry.dialog.removeAttribute('aria-modal'); entry.dialog.style.zIndex = ''; entry.mask.style.zIndex = '';
      } finally {updating = false;}
      // Native close() can move focus while we are still rebuilding the projection.
      // Keep the focus guard quiet until the new top has entered the top layer.
      updating = true;
      sync();
      if (top()) focus(top(), wasTop ? entry.trigger : topFocus);
      else if (usable(originalFocus)) originalFocus.focus({preventScroll:true});
    }
    document.addEventListener('focusin', event => {
      if (updating || !top()) return;
      if (top().dialog.contains(event.target)) top().lastFocus = event.target;
      else focus(top());
    });
    document.addEventListener('keydown', event => {
      const current = top();
      if (!current) return;
      if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); current.close();}
      else if (event.key === 'Tab') current.trapTab(event);
    }, true);
    return {enter, leave, refresh:() => {if (entries.length) sync();}, isTop:entry => entry === top()};
  })();
  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function sourceHref(value) {
    if (!value) return null;
    try {
      const url = new URL(value, document.baseURI);
      return ['file:','http:','https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch (_) {return null;}
  }
  function create({render, loader, resolve, mount = document.body} = {}) {
    if (typeof render !== 'function') throw new TypeError('A Markdown render function is required');
    const dialog = node('dialog', 'maw-doc-dialog'), header = node('div', 'maw-doc-header');
    const title = node('h2'), path = node('p', 'maw-doc-path');
    title.id = 'maw-doc-title-' + (++nextId);
    dialog.setAttribute('aria-labelledby', title.id);
    const heading = node('div', 'maw-doc-heading'); heading.append(title, path);
    const actions = node('div', 'maw-doc-actions'), source = node('a', 'maw-doc-source', '打开源文件');
    source.target = '_blank'; source.rel = 'nofollow noopener noreferrer';
    const closeButton = node('button', 'maw-doc-close', '关闭'); closeButton.type = 'button';
    actions.append(source, closeButton); header.append(heading, actions);
    const status = node('p', 'maw-doc-status'); status.setAttribute('role', 'status'); status.hidden = true;
    const body = node('div', 'maw-doc-body maw-markdown'); body.tabIndex = 0;
    body.setAttribute('role', 'region'); body.setAttribute('aria-label', '使用说明正文');
    dialog.append(header, status, body);
    const mask = node('div', 'maw-doc-fallback-mask'); mask.hidden = true;
    mount.append(mask, dialog);
    let generation = 0, controller, active = false, outsideDown = false;
    const stackEntry = {dialog, mask, closeButton, close, trapTab, nativeModal:false};
    modalStack.refresh();

    function visibleFocusables() {
      return [...dialog.querySelectorAll('a[href],button:not(:disabled),[tabindex="0"]')].filter(el => el.getClientRects().length);
    }
    function close() {
      if (!active) return;
      active = false; generation++; controller?.abort();
      modalStack.leave(stackEntry);
    }
    closeButton.addEventListener('click', close);
    dialog.addEventListener('cancel', event => {event.preventDefault(); if (modalStack.isTop(stackEntry)) close();});
    dialog.addEventListener('close', () => {if (!dialog.open) close();}); // Ignore queued close from an earlier session.
    function trapTab(event) {
      const items = visibleFocusables(), first = items[0], last = items.at(-1);
      if (!first) {event.preventDefault(); closeButton.focus();}
      else if (event.shiftKey && (document.activeElement === first || !items.includes(document.activeElement))) {event.preventDefault(); last.focus();}
      else if (!event.shiftKey && (document.activeElement === last || !items.includes(document.activeElement))) {event.preventDefault(); first.focus();}
    }
    function outside(event) {
      const box = dialog.getBoundingClientRect();
      return event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
    }
    dialog.addEventListener('pointerdown', event => {outsideDown = outside(event);});
    dialog.addEventListener('click', event => {if (modalStack.isTop(stackEntry) && outsideDown && outside(event)) close(); outsideDown = false;});
    mask.addEventListener('click', () => {if (modalStack.isTop(stackEntry)) close();});

    function scrollToHash(hash) {
      if (!hash) return;
      try {
        const id = decodeURIComponent(hash.slice(1));
        const target = [...body.querySelectorAll('[id]')].find(el => el.id === id || el.id === 'maw-md-' + id);
        if (target) {body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top; target.tabIndex = -1; target.focus({preventScroll:true});}
      } catch (_) { /* Malformed anchor is not a document load failure. */ }
    }
    body.addEventListener('click', event => {
      const link = event.target.closest('a[href]');
      if (!link || !body.contains(link) || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const href = link.getAttribute('href');
      if (href.startsWith('#')) {event.preventDefault(); scrollToHash(href); return;}
      const request = resolve?.(link.href);
      if (request) {event.preventDefault(); void open(request);}
    });

    async function open(request, trigger = document.activeElement) {
      const token = ++generation; controller?.abort(); controller = new AbortController();
      active = true;
      dialog.setAttribute('role', 'dialog');
      modalStack.enter(stackEntry, trigger);
      title.textContent = request.title || '使用说明'; path.textContent = request.path || '自定义文档';
      const sourceUrl = sourceHref(request.sourceUrl || request.baseUrl || '');
      source.hidden = !sourceUrl;
      if (sourceUrl) source.href = sourceUrl; else source.removeAttribute('href');
      body.replaceChildren(); body.scrollTop = 0;
      status.textContent = '正在载入说明…'; status.hidden = false; body.setAttribute('aria-busy', 'true');
      if (modalStack.isTop(stackEntry)) closeButton.focus({preventScroll:true});
      try {
        const loaded = Object.hasOwn(request, 'markdown') ? {text:request.markdown, format:request.format || 'markdown'}
          : await loader?.(request, {signal:controller.signal});
        if (!active || generation !== token) return false;
        const content = typeof loaded === 'string' ? {text:loaded, format:'markdown'} : loaded;
        if (!content || typeof content.text !== 'string') throw new Error('此文档未收录，请打开源文件阅读。');
        if (content.format === 'source') {
          const note = node('p', 'maw-doc-source-note', '这是源代码文件，不按 Markdown 解析；下方只读显示全文。');
          const pre = node('pre'), code = node('code', '', content.text); pre.append(code); body.append(note, pre);
        } else body.append(render(content.text, {baseUrl:request.baseUrl || sourceUrl || document.baseURI}));
        // DOM-only layout/accessibility additions; no post-sanitization HTML string operations.
        body.querySelectorAll('table').forEach(table => {
          const wrap = node('div', 'maw-md-table'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', '表格，可横向滚动');
          table.replaceWith(wrap); wrap.append(table);
        });
        body.querySelectorAll('pre').forEach(pre => {
          pre.tabIndex = 0; pre.setAttribute('role', 'region'); pre.setAttribute('aria-label', '代码，可横向滚动');
        });
        body.querySelectorAll('code[class^="language-"]').forEach(code => {
          code.parentElement.before(node('div', 'maw-md-code-language', code.className.slice('language-'.length)));
        });
        body.querySelectorAll('a[href]').forEach(link => {
          if (!link.getAttribute('href').startsWith('#') && /\.md$/i.test(new URL(link.href).pathname) && !resolve?.(link.href)) {
            link.title = '此文档未收录，将打开源文件（不会在弹窗载入）。';
            link.append(node('span', 'maw-md-source-hint', '（打开源文件）'));
          }
        });
        status.hidden = true; body.removeAttribute('aria-busy'); body.scrollTop = 0; scrollToHash(request.hash);
        return true;
      } catch (error) {
        if (!active || generation !== token) return false;
        body.removeAttribute('aria-busy'); status.textContent = '无法载入说明：' + (error.message || '未知错误') + ' 可使用“打开源文件”。';
        return false;
      }
    }
    return Object.freeze({open, close, dialog});
  }
  window.MAWDocViewer = Object.freeze({create});
})();
