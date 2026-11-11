import { getMaweDomPanels } from './editor-dom-panels.js';

export function initMaweDomPanelsWiring() {
  const { assStyleWindow } = getMaweDomPanels();
  [
    MaweDom.editorSettingsPanel,
    assStyleWindow,
    MaweDom.helpPanel,
    MaweDom.gapRemovePanel,
    MaweDom.autoMergePanel,
    MaweDom.subtitleExtendPanel,
    MaweDom.cueListSettingsPanel,
    MaweDom.cueEditorSettingsPanel,
    MaweDom.waveformSettingsPanel,
    document.getElementById('project-settings-panel'),
    ...document.querySelectorAll('.toolbar .dropdown'),
  ].forEach(MaweFloatingPanel.bindFloatingSurfaceActivation);
  window.MaweDomPanelsWiring = getMaweDomPanels();
}
