// Shared frontend runtime registry.
//
// This is deliberately small: it owns module factories only, not editor
// state. Existing window.AsrEditorUtils / window.AsrWaveform and MAWE_*
// exports remain compatibility APIs until later refactor phases migrate their
// consumers.
(function (global) {
  'use strict';

  if (global.MAWE?.version === 1 && typeof global.MAWE.register === 'function') return;

  const factories = new Map();

  function moduleName(name) {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new TypeError(`Invalid MAWE module name: ${String(name)}`);
    }
    return name;
  }

  function register(name, factory) {
    const normalized = moduleName(name);
    if (typeof factory !== 'function') {
      throw new TypeError(`MAWE module ${normalized} must register a factory`);
    }
    if (factories.has(normalized)) {
      throw new Error(`MAWE module already registered: ${normalized}`);
    }
    factories.set(normalized, factory);
  }

  function resolve(name, ...args) {
    const factory = factories.get(moduleName(name));
    return factory ? factory(...args) : undefined;
  }

  const api = Object.freeze({
    version: 1,
    register,
    has: (name) => factories.has(moduleName(name)),
    list: () => [...factories.keys()],
    resolve,
  });

  Object.defineProperty(global, 'MAWE', {
    configurable: false,
    enumerable: false,
    value: api,
    writable: false,
  });
})(window);
