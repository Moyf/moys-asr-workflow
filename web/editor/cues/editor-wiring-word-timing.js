MaweWordTiming.bind();
// 项目设置 → 字幕轨道的「显示字词时间码」镜像开关。
document.getElementById('project-word-timing-toggle')?.addEventListener('change', (event) => {
  MaweWordTiming.setEnabled(event.target.checked);
});
