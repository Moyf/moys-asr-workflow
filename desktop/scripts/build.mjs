import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, Platform } from 'electron-builder';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.platform;
if (!['win32', 'darwin', 'linux'].includes(platform)) throw new Error(`Unsupported build host: ${platform}`);
if (platform !== 'win32') {
  const root = platform === 'darwin' ? '../dist/MAW.app/Contents/MacOS' : '../dist/MAW';
  for (const relative of ['MAW', 'ffmpeg/bin/ffmpeg', 'ffmpeg/bin/ffprobe']) {
    if (!existsSync(path.resolve(desktop, root, relative))) {
      throw new Error(`Build the native MAW backend with FFmpeg first: ${root}/${relative}`);
    }
  }
}
const targetPlatform = { win32: Platform.WINDOWS, darwin: Platform.MAC, linux: Platform.LINUX }[platform];
const unpacked = process.argv.includes('--dir');
if (platform === 'linux') {
  const require = createRequire(import.meta.url);
  const templates = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/linux');
  mkdirSync(path.join(desktop, 'dist'), { recursive: true });
  for (const hook of ['after-install', 'after-remove']) {
    // Keep electron-builder's sandbox/AppArmor and command-link handling;
    // extend its pinned template with our document icon cache updates.
    writeFileSync(path.join(desktop, 'dist', `linux-${hook}.sh`),
      `${readFileSync(path.join(templates, `${hook}.tpl`), 'utf8')}\n${readFileSync(path.join(desktop, 'linux', `${hook}.sh`), 'utf8')}`);
  }
}
await build({
  projectDir: desktop,
  publish: 'never',
  config: path.join(desktop, 'electron-builder.config.cjs'),
  targets: targetPlatform.createTarget(unpacked ? ['dir'] : undefined),
});
