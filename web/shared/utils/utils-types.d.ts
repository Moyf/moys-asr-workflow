/** Widen frozen preset literals while preserving their exact property shape. */
export type MutableValue<T> = T extends string ? string : T extends number ? number
  : T extends boolean ? boolean : T extends readonly (infer U)[] ? MutableValue<U>[]
  : T extends object ? { -readonly [K in keyof T]: MutableValue<T[K]> } : T;
