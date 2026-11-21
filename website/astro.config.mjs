import { defineConfig } from 'astro/config';

const siteUrl = process.env.SITE_URL || 'http://localhost:4321';
const basePath = process.env.BASE_PATH || '/';

export default defineConfig({
  site: siteUrl,
  base: basePath,
  output: 'static',
  outDir: process.env.MAW_SITE_OUTPUT_DIR || './dist',
  compressHTML: true,
});
