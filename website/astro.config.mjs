import { defineConfig } from 'astro/config';

const siteUrl = process.env.SITE_URL || 'http://localhost:4321';
const basePath = process.env.BASE_PATH || '/';

export default defineConfig({
  site: siteUrl,
  base: basePath,
  output: 'static',
  compressHTML: true,
});
