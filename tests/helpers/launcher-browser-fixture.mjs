import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildLauncher } from '../../scripts/build-launcher.mjs';

const launcher = new URL('../../web/launcher/', import.meta.url);

export async function buildLauncherBrowserFixture(directory) {
  const bundle = await buildLauncher(undefined, {
    transform(file, source) {
      if (file === 'launcher/boot/launcher-notify-backend.js') {
        return source + '\nwindow.MAWLauncher = launcherRuntime;\n';
      }
      if (file === 'launcher/boot/launcher-mock-api.js') {
        return source.replace('function mockApi() {', 'function unobservedMockApi() {') + `
function mockApi() {
  const api = unobservedMockApi();
  const { open_runtime_folder, send_notification } = api;
  api.open_runtime_folder = payload => {
    window.__openedRuntimeFolder = payload;
    return open_runtime_folder(payload);
  };
  api.send_notification = ({ title, message } = {}) => {
    (window.__mockNotifications ??= []).push({ title: String(title || ''), message: String(message || '') });
    return send_notification({ title, message });
  };
  return api;
}
`;
      }
      return source;
    },
  });
  const script = join(directory, 'launcher-fixture.js');
  const page = join(directory, 'launcher-fixture.html');
  const template = readFileSync(new URL('index.html', launcher), 'utf8');
  const html = template.replace('<head>', `<head><base href="${launcher.href}">`)
    .replace('src="boot/launcher-bundle.js"', `src="${pathToFileURL(script).href}"`);
  writeFileSync(script, bundle.code, { flag: 'wx' });
  writeFileSync(page, html, { flag: 'wx' });
  return { url: pathToFileURL(page).href, cleanup() { unlinkSync(page); unlinkSync(script); } };
}

export function launcherFixtureUrl() {
  return process.env.MAW_E2E_LAUNCHER_FIXTURE || new URL('index.html', launcher).href;
}
