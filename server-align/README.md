# MAW 录制对齐 MVP

这是一个独立于 MAWE 的本机 Server，用来处理「文稿 + 媒体 + ASR 生成的 `.mosp`」：

```text
script.txt + source.mosp (+ 媒体路径覆盖)
        -> 录制对齐 Server
        -> source.aligned.mosp
        -> MAWE
```

启动：

```powershell
python server-align\serve.py path\source.mosp path\script.txt
```

如果 `.mosp` 没有 `media` 字段，或需要临时替换媒体：

```powershell
python server-align\serve.py path\source.mosp path\script.txt --media path\recording.wav
```

页面会把所有候选 take 直接放在同一条完整横向时间轴上；块的位置始终对应源媒体时间码，不做时间折叠：

- `match` ：完整匹配，默认采用，绿色显示；
- `skip-source` ：失败句、口吃、重复段或未采用的 Alternative，默认禁用；其中 `reasonCode: "repetition"` 表示已选 take 内部检测到的重复源段；
- `incomplete` ：只有部分文稿内容，默认禁用；用户可以直接点击波形块，或在候选列表中点击「手动启用」，覆盖这一次自动禁用；再次点击已启用的波形块会恢复自动禁用；
- `missing-script` ：文稿行没有可靠候选；
- `alternative` ：同一文稿行、同一局部录制组内的其他完整候选，可以点击切换；
- `distant-match` ：文本匹配但与当前 Alternative 组距离过远的命中，按 Extra 显示，默认保留并等待用户确认；
- `extra` ：文稿之外的源录音，默认保留，用户可以改为禁用；连续的 Extra 会按每个源字幕段（或同一段内连续 item）拆成独立块，分别试听和决策。

选中的完整 take 前面，如果有一小段紧邻的源录音，文本明显从同一文稿开头开始、但没有形成可靠完整候选，工具会将它从普通 `extra` 提升为 `skip-source`，并标记为 `incomplete` 默认禁用。这只处理紧邻重录的保守情况；独立的文稿外内容仍保持 `extra` 默认保留。

预览区采用与 MAWE 相同的基本时间线语义，并提供 `基础` / `多行` 两种波形视图。基础模式按固定时间尺度绘制完整横向波形，take 块直接覆盖在波形区内，整段内容超出视口时通过底部横向滚动条查看，不把整段媒体压缩到一个屏幕内；多行模式按「每行」时长切分为纵向行，并可调整行高，便于快速查看较长录音。两种模式都共用原始时间码，基础模式横向滚动，多行模式纵向滚动。

所有块共用同一条时间坐标，块内显示状态 badge 和源字幕文本；同一文稿行的候选带有 `data-alternative-group` 关系，点击一个 take 会立即点亮它并将同组其他候选静音。单击波形定位，双击播放/暂停，按住左键拖动播放头，鼠标移动时显示时间指针；按住 `Ctrl` 单击字幕块会滚动到下方对应的录制 card，并短暂高亮目标。基础模式下鼠标滚轮会横向滚动时间轴，多行模式保留纵向滚动。播放中的播放头使用 `requestAnimationFrame` 独立刷新，不依赖低频 `timeupdate` 事件；播放头自动滚动也会根据当前模式跟随横向或纵向视口。时间轴提供两个独立开关：`播放时跳过 gap` 默认关闭，关闭时播放头会经过 gap；`播放头跳转时自动滚动` 默认启用。页面空白区域按空格键也可以播放/暂停；点击波形块、checkbox、按钮等操作控件后会释放焦点，使空格键继续控制播放/暂停，文本输入框仍保留正常焦点行为。

候选的自动禁用是可覆盖的建议状态，不是不可逆操作：选中的 `incomplete` take 默认不会进入保留区间；点击「手动启用」后，它会进入导出保留区间，并在界面上显示为绿色的「手动启用」。导出的 `script_alignment` 会同时保留 `incomplete` 分类、`candidateActions`、`manuallyEnabledCandidateIds` 和仍未解除的 `blockedIncompleteLineIds`，便于区分识别结果与用户覆盖。

播放时是否跳过 gap 只影响当前预览，不影响导出；导出的 `gap_remove` 仍按已标记的移除空隙生成。

候选和 Extra 的“试听”是原始素材审查操作，即使该范围在最终预览中会被转成 remove-gap，也仍然直接播放该源范围；最终播放/导出的时间线才会跳过被移除的 gap。

导出不会覆盖输入工程，而是生成 `source.aligned.mosp`（同名文件存在时递增编号）。导出的工程：

- 默认保留原始 `segments[*].start/end/items`，不改写 ASR 时间码；如果一个带有有效 `items` 的源段同时包含文稿内容和 Extra，则按 item 边界拆成多个字幕段，保留各自原始 item 时间码；
- 对未采用 take 和被禁用的 Extra 设置 `segments[*].disabled = true`；
- 将保留区间之外的时间写入 `gap_remove.gaps`，`removed: true`；
- 如果输入 mosp 有内嵌 waveform，则按 MAWE 的 audio gate 规则额外检测静音空隙；
- 写入 `script_alignment` 元数据，保留选择结果和缺失/不完整状态，便于后续诊断。

当前 MVP 只做选择、禁用和 gap-remove 工程输出，不重编码媒体；打开输出的 `.mosp` 后，MAWE 可以继续播放跳过空隙、编辑字幕和导出去空隙版本。没有内嵌 waveform 时，take 块仍可用，但需要在 MAWE 中重新扫描静音空隙。

候选的顺序和 take 组合仍以 mosp 的启用字幕段为单位；有完整 `items` 时，目标句是某个源段的安全前缀/后缀，就会把候选边界下沉到 item 边界。导出时，目标句、Extra 和禁用尾段会拆成独立字幕段；没有有效 `items` 的旧工程仍只能按字幕段边界处理。

同一文稿行的完整候选会再按源时间建立局部录制组：相邻候选之间默认最多相隔 `10000ms`，且最多跨过 `8` 个源字幕段；任一条件超出就会断组。默认选择“最后一版”只在当前局部组内生效，远距离命中不会自动作为未选 Alternative 禁用；可在候选列表中手动采用，或在 Extra 区域单独保留/禁用。

选中一个完整 `match` take 后，工具还会做一次保守的内部重复检查：如果同一 take 内相邻的两个完整源字幕段文本相同、之间有明显停顿，而文稿中只出现一次该短语，就把前一个标为 `重复 · 禁用`，保留后一个继续衔接。这个结果不是新的 Alternative，而是该 take 内部的 `skip-source`；导出时会从已保留区间中扣除它，并写入 `gap_remove.gaps`。
