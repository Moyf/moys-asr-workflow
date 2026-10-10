interface DocNavigationGroup {
  label: string;
  docs: [slug: string, title: string, description: string][];
}

// The overview and every article share the same reading order.
export const docsNavigation: DocNavigationGroup[] = [
  {
    label: '开始与转写',
    docs: [
      ['getting-started', '开始使用 MAW', '产品简介与下载入口。'],
      ['workflow', '第一次字幕工程', '安装、配置、转写、编辑与交付。'],
      ['launcher', 'Launcher 指南', '识别预设、音轨、批量任务与输出设置。'],
      ['providers', '服务商配置', 'Key、地域、模型与数据边界。'],
      ['faq', '常见问题', '启动、FFmpeg、API 与保存排错。'],
    ],
  },
  {
    label: '日常编辑',
    docs: [
      ['editor-guide', '编辑器指南', '播放、文字与时间调整、保存、备份和导出。'],
      ['keyboard-adjustment', '按键调整', '精确调整字幕位置与边界。'],
    ],
  },
  {
    label: '进阶专题',
    docs: [
      ['multi-subtitle', '多重字幕', '主副轨导入、绑定与联动。'],
      ['ass-styles', 'ASS 样式', '样式库、实际帧预览与特殊文本格式。'],
      ['toolbox', '工具箱', '匹配、AI 整理、翻译与媒体处理。'],
      ['postprocess-pipeline', '自动处理', '转写后串接步骤、烧录与失败恢复。'],
      ['local-asr', '实验性本地 ASR', '模型、运行环境、设备与时间码对齐。'],
      ['ocr-subtitle-dedup', 'OCR 去重', '视频画面字幕检测与报告。'],
    ],
  },
  {
    label: '自动化与开发参考',
    docs: [
      ['cli', '命令行 CLI', '公开参数、底层脚本与自动化。'],
      ['json-schema', '工程格式', 'MOSP / JSON 字段与时间码契约。'],
      ['llm-postprocess', 'LLM 协议', 'ID 校验与本地时间映射。'],
      ['mose', 'MAW / MAWE / MOSE', '当前产品与实验桌面目录的关系。'],
      ['development', '开发概览', '代码地图、数据边界与验证。'],
      ['documentation-index', '全部文档与历史记录', '专题索引、开发计划和测试账本。'],
    ],
  },
];
