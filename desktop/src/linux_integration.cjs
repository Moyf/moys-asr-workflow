'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function quoteDesktopExecutable(value) {
  // Desktop Entry escaping is distinct from shell escaping. No shell runs.
  return `"${value.replaceAll('%', '%%').replace(/[\\"`$]/gu, '\\$&')}"`;
}

async function installLinuxIntegration({ applicationPath, assetsPath, dataHome, execFileImpl = execFile }) {
  if (!path.isAbsolute(applicationPath) || !fs.statSync(applicationPath).isFile() || !path.isAbsolute(dataHome)) {
    throw new Error('请选择有效的本地应用路径。');
  }
  const write = (relative, data) => {
    const target = path.join(dataHome, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { mode: 0o644 });
  };
  write('applications/com.moy.mose.desktop', [
    '[Desktop Entry]', 'Type=Application', 'Name=MOSE',
    'Comment=Subtitle project editor', `Exec=${quoteDesktopExecutable(applicationPath)} %f`,
    'Icon=mose', 'Terminal=false', 'Categories=AudioVideo;AudioVideoEditing;',
    'MimeType=application/x-mose-project;', 'StartupWMClass=MOSE', '',
  ].join('\n'));
  write('mime/packages/com.moy.mose.xml', [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">',
    '  <mime-type type="application/x-mose-project">',
    '    <comment>MOSE subtitle project</comment>',
    '    <sub-class-of type="application/json"/>', '    <glob pattern="*.mosp"/>',
    '    <icon name="application-x-mose-project"/>', '  </mime-type>', '</mime-info>', '',
  ].join('\n'));
  write('icons/hicolor/256x256/apps/mose.png', fs.readFileSync(path.join(assetsPath, 'maw.png')));
  write('icons/hicolor/256x256/mimetypes/application-x-mose-project.png', fs.readFileSync(path.join(assetsPath, 'mosp.png')));
  const update = (command, args) => new Promise((resolve) => {
    execFileImpl(command, args, (error) => resolve(error ? command : ''));
  });
  const warnings = (await Promise.all([
    update('update-mime-database', [path.join(dataHome, 'mime')]),
    update('update-desktop-database', [path.join(dataHome, 'applications')]),
    update('gtk-update-icon-cache', ['-q', '-t', '-f', path.join(dataHome, 'icons/hicolor')]),
  ])).filter(Boolean);
  // Register as an available application. Do not replace a user's default.
  return { warnings };
}

module.exports = { installLinuxIntegration, quoteDesktopExecutable };
