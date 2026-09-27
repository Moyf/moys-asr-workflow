// ESM 试点：已转换为真 ES Module 的清单文件（单一事实来源）。
// 消费方：build-hybrid（打包入口）、editor-module-loader（测试加载器）、
// test_editor_script_order（经典世界断言的豁免名单）。
// 完整迁移完成后本清单随 editor-scripts.txt 一起退役。
export const CONVERTED = [
  'shared/host/storage.js',
  'shared/host/files.js',
  'shared/host/server-api.js',
  'editor/boot/editor-host.js',
];
