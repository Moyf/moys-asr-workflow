// Storage errors remain visible to callers so each preference keeps its fallback.
window.MAWE.register('host-storage', function createStorage(environment) {
  'use strict';
  return Object.freeze({
    getItem: (key) => environment.localStorage.getItem(key),
    setItem: (key, value) => environment.localStorage.setItem(key, value),
  });
});
