/* In-memory documentation resolver. No fetch: file:// works with ordinary local script tags. */
(function () {
  'use strict';
  function create({data, baseUrl}) {
    const base = new URL('.', baseUrl);
    const documents = data?.documents || {};
    function resolve(href) {
      try {
        const url = new URL(href, base);
        if (url.protocol !== base.protocol || url.host !== base.host || !url.pathname.startsWith(base.pathname) || url.search) return null;
        const path = decodeURIComponent(url.pathname.slice(base.pathname.length));
        if (!Object.hasOwn(documents, path)) return null;
        const source = new URL(url); source.hash = '';
        return {path, title:path, sourceUrl:source.href, baseUrl:source.href, hash:url.hash};
      } catch (_) {return null;}
    }
    function load(request) {
      if (!Object.hasOwn(documents, request.path)) throw new Error('此文档未收录，请打开源文件阅读。');
      return documents[request.path];
    }
    return Object.freeze({resolve, load});
  }
  window.MAWToolDocData = Object.freeze({create});
})();
