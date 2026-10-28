# 轨道读取 ESM 测试适配：独立自审

基准：`feat/track-unification-p0p1@197da463` + 本次测试与文档 diff。审查者未参与实现，按当前 AGENTS.md / DEVELOPMENT.md 的提交前要求独立通读全部 diff；只读审查，没有修改源文件。

## 结论

未发现 blocker、major、minor 或需修复的 nit，没有未处置的提交阻断项。本次没有生产代码 diff，没有修改 golden 数据或降低原断言语义。

| 审查点 | 代码与执行证据 | 结论 |
| --- | --- | --- |
| ESM 装配真实性 | tests/helpers/track-golden.mjs 使用 compileSources、当前 manifest 顺序与模块表，执行完整 init/static import | 已确认；没有剥 import、按注释截取或伪实现 |
| VM 门面与隔离 | window 与全局共用门面；审查者独立探针确认两次 harness 的 MAWE/overlay 命名空间彼此独立 | 已确认；run-id 20261027T154113Z-08ddbbf0 |
| 引用协议 | tests/test_track_access.mjs 新增测试覆盖懒规范化替换 overlay，再覆盖同工程二次替换；独立探针核验 getter/CueRef 返回原对象 | 已确认；未缓存旧容器/旧 cue |
| 冻结语义 | tests/test_track_semantics.mjs 的条目数量与预览/烧录开关断言保持；全部 golden JSON、read-contract.json、test_track_golden.mjs 无 diff | 已确认；无重录或放宽期望 |
| 定向独立复验 | node --test tests/test_track_access.mjs tests/test_track_golden.mjs tests/test_track_semantics.mjs | 20/20，0 fail/skip；run-id 20261027T154053Z-c12674de |
| 双向/全量证据回读 | 旧 helper 回退运行确实失败且已恢复；全量 1004/1004、typecheck/build 的 result.json 回读一致；独立 git diff --check 通过 | 已确认，详见修复记录中的 run-id |

完整日志与结果位于忽略目录 `.artifacts/checks/<run-id>/`；探针脚本仅留本地，不入库。

## 接受的验证边界

- DOM-free 子集装配不证明完整浏览器交互、字体像素或真实视频烧录；本次只修测试装配，没有相关生产行为改动，保留原人工验收边界。
- 当前 Node 25.8.2 不在新 package.json engines 声明内，pnpm 输出警告；实际本机全量、typecheck/build 通过，但没有据此宣称支持范围内所有版本或远端 CI 已通过。

处置：上述为已记录的验证边界，没有通过跳过测试、修改运行时声明或改写黄金期望来掩盖。本次可以本地提交，不 push。
