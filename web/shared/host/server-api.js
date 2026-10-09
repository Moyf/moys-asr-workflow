// URL resolution and transport belong to the host; response policy stays in callers.
export function createServerApi(dependencies) {
  'use strict';
  const { browser, environment } = dependencies;
  return Object.freeze({
    fetch(url, options) {
      return environment.fetch(new environment.URL(url, browser.location.href), options);
    },
  });
}
