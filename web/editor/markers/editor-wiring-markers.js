// 「标记与区段」工具窗接线：面板控制器由 editor-markers-panel.js 在装载时
// 通过 createFloatingPanel 创建（已绑定工具栏按钮与 Esc）；这里只补关闭按钮。
MaweDom.markersCloseButton?.addEventListener('click', () => MaweMarkersPanel.closePanel());
