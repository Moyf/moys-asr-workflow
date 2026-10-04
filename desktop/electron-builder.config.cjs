'use strict';

const { build } = require('./package.json');

// Windows shares the MAW suite. Native macOS/Linux builds carry one backend
// under resources/backend and can run independently of the Launcher.
module.exports = {
  ...build,
  mac: {
    target: ['dir', 'dmg', 'zip'],
    category: 'public.app-category.video',
    icon: '../assets/maw.icns',
    identity: null,
    artifactName: 'MOSE-macOS-${arch}-v${version}.${ext}',
    extraResources: [{ from: '../dist/MAW.app', to: 'backend/MAW.app' }],
    fileAssociations: [{ ext: 'mosp', name: 'MOSE Project', role: 'Editor', rank: 'Alternate', icon: '../assets/mosp.icns' }],
    extendInfo: {
      CFBundleDocumentTypes: [{
        CFBundleTypeName: 'MOSE Project', CFBundleTypeRole: 'Editor',
        LSItemContentTypes: ['com.moy.mose.project'], LSHandlerRank: 'Alternate',
        CFBundleTypeIconFile: 'mosp.icns',
      }],
      UTExportedTypeDeclarations: [{
        UTTypeIdentifier: 'com.moy.mose.project',
        UTTypeDescription: 'MOSE Project',
        UTTypeConformsTo: ['public.json'],
        UTTypeTagSpecification: {
          'public.filename-extension': ['mosp'],
          'public.mime-type': 'application/x-mose-project',
        },
      }],
    },
  },
  linux: {
    target: ['dir', 'AppImage', 'deb'],
    executableName: 'mose',
    executableArgs: ['%f'],
    category: 'AudioVideo;AudioVideoEditing;',
    icon: '../assets/maw-icon-rounded.png',
    maintainer: 'Moyf',
    artifactName: 'MOSE-Linux-${arch}-v${version}.${ext}',
    extraResources: [{ from: '../dist/MAW', to: 'backend/MAW',
      filter: ['**/*', '!_internal/{libstdc++.so.6,libgcc_s.so.1,libgbm.so.1,libreadline.so.*}'],
    }],
    fileAssociations: [{ ext: 'mosp', name: 'MOSE Project', mimeType: 'application/x-mose-project' }],
    desktop: { entry: { StartupWMClass: 'MOSE' } },
  },
  deb: { afterInstall: 'dist/linux-after-install.sh', afterRemove: 'dist/linux-after-remove.sh' },
};
