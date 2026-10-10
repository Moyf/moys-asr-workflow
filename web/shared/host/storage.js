// Storage errors remain visible to callers so each preference keeps its fallback.
export function createStorage(environment) {
  'use strict';
  return Object.freeze({
    getItem(key) {
      const native = environment.MOSEDesktop?.storage;
      if (!native) return environment.localStorage.getItem(key);
      const saved = native.getItem(key);
      if (saved !== null) return saved;
      // Import an existing preference from this origin on its first native read.
      const legacy = environment.localStorage.getItem(key);
      if (legacy !== null) native.setItem(key, legacy);
      return legacy;
    },
    setItem(key, value) {
      const native = environment.MOSEDesktop?.storage;
      if (native) native.setItem(key, value);
      else environment.localStorage.setItem(key, value);
    },
  });
}
