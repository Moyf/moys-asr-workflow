/* Marked owns parsing; DOMPurify owns sanitization. This module has no viewer dependency. */
(function () {
  'use strict';
  const allowedTags = ['a','p','br','hr','h1','h2','h3','h4','h5','h6','blockquote','ul','ol','li',
    'strong','em','del','mark','pre','code','table','thead','tbody','tr','th','td','input','span','div'];
  const allowedAttributes = ['href','title','class','id','target','rel','start','align','type','checked','disabled'];
  const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function resolveUrl(href, baseUrl, options = {}) {
    const raw = String(href || '').trim();
    if (!raw || /[\u0000-\u001f\u007f]/.test(raw) || /&(?:#[^;\s]+|[a-z][a-z\d]*);/i.test(raw)) return null;
    // Percent-encoded schemes are not links. URL resolution alone would turn them into local paths.
    let decoded = raw;
    try {for (let i = 0; i < 3; i++) {const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next;}} catch (_) {return null;}
    if (/[\u0000-\u001f\u007f]/.test(decoded) || /&(?:#[^;\s]+|[a-z][a-z\d]*);/i.test(decoded)) return null;
    const scheme = /^([a-z][a-z\d+.-]*):/i.exec(decoded);
    if (scheme && !['http','https','mailto'].includes(scheme[1].toLowerCase())) return null;
    if (options.absoluteOnly && !/^(?:https?|mailto):/i.test(raw)) return null;
    try {
      const base = new URL(baseUrl);
      const url = new URL(raw, base);
      if (!['http:','https:','mailto:','file:'].includes(url.protocol) || url.username || url.password) return null;
      if (url.protocol === 'file:' && (base.protocol !== 'file:' || /^[a-z][a-z\d+.-]*:/i.test(raw)
        || /^[\\/]|^[a-z]:/i.test(raw) || /^[\\/]|^[a-z]:/i.test(decoded)
        || raw.includes('\\') || decoded.includes('\\') || url.host !== base.host)) return null;
      const sameDocument = url.origin === base.origin && url.pathname === base.pathname && url.search === base.search;
      if (sameDocument && url.hash) {
        const id = decodeURIComponent(url.hash.slice(1));
        return {href:'#' + encodeURIComponent(id.startsWith('maw-md-') ? id : 'maw-md-' + id), external:false};
      }
      return {href:url.href, external:url.protocol !== 'file:' && (url.origin !== base.origin || url.protocol === 'mailto:')};
    } catch (_) {return null;}
  }

  function highlightExtension() {
    return {
      name:'mawHighlight', level:'inline',
      start(src) {return src.indexOf('==');},
      tokenizer(src) {
        if (!src.startsWith('==') || !src[2] || /\s|=/.test(src[2])) return;
        const lineEnd = src.search(/[\r\n]/), line = src.slice(2, lineEnd === -1 ? undefined : lineEnd);
        // Marked's standard inline lexer identifies indivisible code/link/image tokens.
        // Only delimiter discovery is custom; neither inline grammar nor rendering is reimplemented.
        const standard = new window.marked.Lexer({gfm:true, extensions:null});
        standard.tokens.links = this.lexer.tokens.links;
        let offset = 2;
        for (const token of standard.inlineTokens(line)) {
          if (!['codespan','link','image','html','escape'].includes(token.type)) {
            for (let index = 0; index < token.raw.length - 1; index++) {
              if (token.raw[index] === '\\') {index++; continue;}
              // Emphasis tokens can themselves contain code or links. Ask Marked
              // about those inner boundaries rather than treating their raw text as delimiters.
              if ('`[!<'.includes(token.raw[index])) {
                const nested = standard.inlineTokens(token.raw.slice(index))[0];
                if (nested && ['codespan','link','image','html','escape'].includes(nested.type)) {
                  index += nested.raw.length - 1; continue;
                }
              }
              if (token.raw.startsWith('==', index)) {
                const end = offset + index, text = src.slice(2, end);
                if (!text.trim()) return;
                return {type:'mawHighlight', raw:src.slice(0, end + 2), tokens:this.lexer.inlineTokens(text)};
              }
            }
          }
          offset += token.raw.length;
        }
      },
      renderer(token) {return '<mark>' + this.parser.parseInline(token.tokens) + '</mark>';},
      childTokens:['tokens'],
    };
  }

  function tokenText(tokens) {
    return tokens.map(token => token.tokens ? tokenText(token.tokens) : token.text || '').join('');
  }

  function render(markdown, options = {}) {
    if (!window.marked?.Marked || !window.DOMPurify?.sanitize || window.DOMPurify.isSupported === false) throw new Error('Local Marked and DOMPurify resources are required in a supported browser');
    const baseUrl = options.baseUrl || document.baseURI;
    const ids = new Set();
    const parser = new window.marked.Marked({gfm:true, breaks:false, async:false});
    parser.use({extensions:options.highlight === false ? [] : [highlightExtension()], renderer:{
      html({text}) {return escape(text);}, // Raw HTML is visible text, never an active element.
      heading({tokens, depth}) {
        const slug = tokenText(tokens).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
        let id = 'maw-md-' + slug, suffix = 0;
        while (ids.has(id)) id = 'maw-md-' + slug + '-' + (++suffix);
        ids.add(id);
        return `<h${depth} id="${escape(id)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      link({href, title, tokens}) {
        const label = this.parser.parseInline(tokens), url = resolveUrl(href, baseUrl, options);
        if (!url) return label;
        return `<a href="${escape(url.href)}"${title ? ` title="${escape(title)}"` : ''}`
          + (url.href.startsWith('#') ? '' : ' target="_blank" rel="nofollow noopener noreferrer"') + `>${label}</a>`;
      },
      image({href, text}) {
        const url = options.noImages ? null : resolveUrl(href, baseUrl, options);
        return '<span class="maw-md-image">图片未自动加载：' + escape(text || '未命名图片')
          + (url ? ` · <a href="${escape(url.href)}" target="_blank" rel="nofollow noopener noreferrer">打开图片</a>` : options.noImages ? '（此视图禁用图片入口）' : '（地址不可用）') + '</span>';
      },
    }});
    // The only HTML-to-DOM boundary. Nothing rewrites the sanitized HTML string.
    return window.DOMPurify.sanitize(parser.parse(String(markdown ?? '')), {
      ALLOWED_TAGS:allowedTags, ALLOWED_ATTR:allowedAttributes, ALLOW_DATA_ATTR:false,
      ALLOWED_URI_REGEXP:/^(?:(?:https?|mailto|file):|#)/i,
      ADD_URI_SAFE_ATTR:['type','target','rel','start','align','checked','disabled'],
      ALLOW_ARIA_ATTR:false, RETURN_DOM_FRAGMENT:true, SANITIZE_DOM:true,
    });
  }
  window.MAWMarkdown = Object.freeze({render, resolveUrl});
})();
