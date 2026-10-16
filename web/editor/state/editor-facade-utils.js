/**
 * Freeze a public facade at runtime without erasing accessor setter types.
 * `Object.freeze` returns `Readonly<T>` in TypeScript, even when a property has
 * a real setter. Keep only declared accessor setters writable in checkJs
 * consumers; data properties remain readonly in the static type.
 * @template {object} T
 * @template {keyof T} K
 * @param {T} facade
 * @param {ReadonlyArray<K>} writableAccessors
 * @returns {Readonly<Omit<T, K>> & Pick<T, K>}
 */
export function freezeFacade(facade, writableAccessors) {
  void writableAccessors;
  return Object.freeze(facade);
}
