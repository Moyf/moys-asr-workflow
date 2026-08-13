const rawBase = import.meta.env.BASE_URL || '/';

export const siteBase = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;

export function sitePath(path = '') {
  return `${siteBase}${path.replace(/^\/+/, '')}`;
}
