# Moy's ASR Workflow（MAW）

QQ 交流群：[1079160201](https://qm.qq.com/q/4YtxZIpzxC)

> Up 精力有限，如有新需求请提 Issues，Q群仅供交流不接CPU。

## 这是什么

这是个 2026 年新时代的**字幕生成+编辑**工作流：  
把一个视频或音频交给 AI 转写，得到可编辑的字幕工程和SRT文件。  

全过程快到你反应不过来！  
<img src="assets/show.webp" width="300" alt="sticker">

## MAW 组成
Moy 的 ASR 工作流由两部分组成：  

- **MAW Launcher**：负责媒体处理和发送 AI 转写请求，生成工程并启动编辑器。  

![launcher](assets/launcher.jpg)  


- **MAWE**：MAW 自带的字幕编辑器，功能有九分甚至十分的强劲：

![MAWE 字幕编辑器预览](assets/screenshot-v1.2.0.jpg)  

*当前 Release 默认使用 Server 版编辑器；便携 HTML 编辑器仍可作为备用入口。MOSE 桌面版暂不随 MAW 分发，待完成度足够后再恢复。*

## 如何使用

[点我下载最新版](https://github.com/Moyf/moys-asr-workflow/releases/latest)，根据电脑情况选一个：

- `MAWxFF-Windows-x64-v*.zip`：已经捆绑 MAW 所需的 `ffmpeg.exe` 和 `ffprobe.exe`；没有 FFmpeg、或者不知道它是什么，下载这个。
- `MAW-Windows-x64-v*.zip`：体积更小；适合已经安装 FFmpeg，并且终端能直接运行 `ffmpeg` / `ffprobe` 的用户。
- Mac 端同理，不再赘述。

Windows 下载解压之后点击 `MAW.exe` 并运行；macOS 下载后解压并打开 `MAW.app`。

### 申请 API Key

由于本地模型有一定的配置需求，做起来也更麻烦，因此 MAW 优先提供 API 转写服务。
本地模型功能尚在[开发中](https://github.com/Moyf/moys-asr-workflow/pull/19)。

QwenASR 的水平如下：
<img width="1604" height="1055" alt="image" src="https://github.com/user-attachments/assets/6c2f0272-f90b-4f2d-ae84-e2b68b173d02" />
[数据来源](https://qwen.ai/blog?id=qwen3asr)

> [!tip]
> [如何获取阿里云百炼的 Qwen-Audio/Fun-ASR API](https://help.aliyun.com/zh/model-studio/get-api-key)
> （不含广告，默认使用最新的 Qwen-Audio 3.0 ASR 模型，支持长音频、热词、说话人分离和提示词）

如果你更在意小语种多语言，可以使用 [Soniox Console](https://console.soniox.com) 申请 Key。

**两个 Key 不需要同时配置，用到哪个配哪个即可。**

配完之后点击「保存到本地环境」，下次就不用重复配置了。

<details>
<summary>🔐 为了方便你快速体验，你可以先用这个 key 尝试 </summary>
  
**解密网站：** [魔曰](https://abracadabra-demo.pages.dev/)

**话语：** `此夜有早鹤远璃，智水清路。遥书为鹏兮，惠琴为路。局以莹聪，恭登益莺，此鸳有长天美星，盈涧青声。是家也，声悦冰高，裳寒光雅。或探冰动鸳，行叶于空，事瑞竹，学莹语。此鹂有临树瀚琴，青铃秋语。鹤鹤见雪，莹于雪叶，余恋静飞，恋文湛换。或关城探鹏，见木于韵，飞瑞鸳，驿聪楼良，乃后关。此心有瀚火速棋，聪鸳盈光。不必问也，或学铃留鸢，致月于雨。流早霞，恋明楼善，乃速探。莹风定棋，书莺致福。虽返说极悠，明少不同。此礼有彩光青天，纯火旧鲤。此铃有慧声新木，绮恋冷棋，或振水选家，流驿于镜。`  
  
**密钥：** `moimoi`
  
> 目前应该还剩6小时的额度，**请勿滥用**，如果发现异常情况我会直接禁用这个key ヽ(\` 3 ´)ﾉ  
> 用不了了就说明额度被薅光了，为了方便大家体验，还请尽量只做2分钟内的测试，觉得 OK 再申请 API 来用w

</details>


## 流程说明

1. 在 Launcher 中打开媒体，填写 API Key 后，点击 **生成字幕和工程**——MAW 会调用对应的模型把本地视频或音频转为字幕，同时生成工程文件。
2. 如果你不需要精校字幕，直接用生成的 srt 字幕文件即可 🎉
3. 生成工程后，主按钮默认启动 Server 版字幕编辑器；也可以从右侧菜单打开工程 HTML 编辑器或空白 HTML 编辑器。
4. 操作完成后，点击右上角按钮导出你所需的 SRT 字幕或是其他附加格式。

所有编辑都在本机完成。  
转写时，脚本会把待识别媒体直接上传到你选择的阿里云百炼或 Soniox 账户；本项目没有自己的服务器、不会代管你的 API Key 或媒体。

### 命令行与 AI 自动化

Release 包中的 `MAW.exe` 也可以脱离 Launcher 直接转写指定媒体，生成 SRT 和 `.mosp`，并能启动或停止本机 Server：

```powershell
.\MAW.exe -i "D:\Videos\example.mp3" -o "D:\Output\example.srt" "D:\Output\example.mosp"
```

它适合脚本、批处理和 AI 自动化调用。给 AI 使用时，请让它先读取 [CLI 专门文档](docs/CLI.md)，使用双引号包住路径，不要把 API Key 放进命令行，先用 `-ll 2m` 做小样本，并依据退出码和输出文件判断是否成功。完整参数表、Qwen/Soniox 选项、Server 管理和 PowerShell 模板都在该文档中。

Launcher 的后处理工具箱第一个工具是「文稿匹配」：可用本地 UTF-8 文稿修正文案、标点和字幕文字，同时保留原字幕时间；也可选用 DeepSeek、智谱 Coding Plan、阿里云 Qwen 或自定义 OpenAI-compatible 服务校对、重分句或翻译字幕。LLM 步骤只发送带临时 ID 的字幕文字，不发送时间码、媒体路径或工程元数据；选择供应商即表示字幕文字会按该服务商的条款和隐私政策传输。LLM Key 可在 Launcher 右上角 `⚙️ 配置` 中管理，只保存在本机 `.env`，不会写入工程、SRT 或日志。

## 概览特性
点击查看：[3分钟速览 MAW 特性](https://www.bilibili.com/video/BV1hXum6yELT) 

- 使用阿里云百炼的 QwenASR/FunASR 或者 Soniox 的 API 进行语音转录，一键生成 srt 字幕文件和 mosp 工程文件
- 自带 MAWE 字幕编辑器，支持：
  - 多行波形快速查看，点击字幕或波形可跳转
  - 可检测并移除静音空隙，播放时自动跳过，支持导出 OTIO 工程
  - 拆分或合并字幕：**拆分后会按精准时间码自动分配两侧字幕的时间范围**
  - 可显示当前单句的时长、字数和阅读速度，并过滤过长文本
  - 支持批量替换关键字
  - 视频画面内的字幕预览可直接拖动和缩放
  - 拼合字幕：把间隔小于阈值的相邻字幕拓展贴合，并吸收过短的字幕
  - 可保存 `.mosp` 工程用于下次编辑，或导出标准 SRT 字幕等格式。
- 操作部分
  - WASD 快速跳转前后字幕
  - 鼠标停在已选字幕行时，Enter 原地编辑，B 在鼠标所指的文字位置拆分；B 在波形上按音频位置、其它区域按播放指针拆分
  - 还有诸多快捷键，极大提高剪辑效率——详见右上角 **【🤔 帮助】** 按钮
- 拓展功能
  - 可给字幕附加**表情包**或**颜色**，并在多句字幕之间保持关联，一同修改
  - 支持按颜色导出多个字幕文件，用于多个说话人等情况
  - 表情包可以播放预览，或导出 OTIO 工程使用

> [!note]  
> 多行波形相关特性参考了 [gap-gone](https://github.com/LiRenTech/gap-gone) 项目 ❤️  

详细的使用方法、数据要求和导出说明见 [编辑器指南](docs/EDITOR_GUIDE.md)。字幕时间微调快捷键见 [字幕按键调整文档](docs/KEYBOARD_ADJUSTMENT.md)。
完整步骤、常用参数与排错见 [docs/WORKFLOW.md](docs/WORKFLOW.md)，工程文件的数据结构见 [JSON_SCHEMA.md](JSON_SCHEMA.md)。

## 关于 API

- 这是 **API-first** 工具，不含模型下载和本地推理引擎。
- API Key 仅读取自环境变量或本机 `.env`；`.env` 已被 Git 忽略，绝不要提交、截图或发给别人。
- 每次转写会使用你的 Key 调用所选供应商；文件大小、数据保留与账户政策请分别查看[百炼语音识别文档](https://help.aliyun.com/zh/model-studio/asr-model/)或 [Soniox 文档](https://soniox.com/docs)。
- 百炼 Provider 提供 `qwen3-asr-flash-filetrans`、`qwen-audio-3.0-asr-flash-filetrans` 和 `fun-asr`，支持北京与新加坡地域；北京可选填 Workspace ID 使用推荐的专属域名，新加坡必须填写。Qwen-Audio、Fun-ASR 与 Soniox 均可选说话人分离。配置项说明都在 `.env.example`。

### 费用

- 本项目本身是开源项目，可免费使用；默认模型为阿里云百炼最新发布的 Qwen-Audio 3.0，也可以在 GUI 或命令行里改用同 Provider 的 Qwen3-ASR、Fun-ASR 或 Soniox。
- 阿里云 Qwen ASR 注册后免费赠送 10 小时转录时间，超出额度后按 `0.792 元/小时` 计费，详见 [价格文档](https://help.aliyun.com/zh/model-studio/model-pricing#dbf1305ef4a69)。
- Soniox 异步文件转写约 `$0.10/小时`，适合需要说话人分离、多语言或小语种的素材，详见 [Soniox Pricing](https://soniox.com/pricing)。
- 如果你有不错的配置，也可以自己本地部署开源的 [QwenASR](https://github.com/QwenLM/Qwen3-ASR) 本地转录，不产生云端费用，只需要一点电费。

😭*我说我只有一台 AMD 显卡的台式机和一台 Mac Mini 所以跑不了本地模型有懂的吗*  

## 致谢

❤️ 感谢 @Hanekit 老师的宝贵意见和建议  
❤️ 感谢 @大狗 老师的超绝可爱表情包支持  
❤️ 感谢 @LiRenTech 的 [gap-gone](https://github.com/LiRenTech/gap-gone) 项目  
<sup>本项目的多行波形和空隙去除灵感皆来源于此</sup>  
🤖 感谢 ChatGPT 和 OpenCode 的代码助力（咦）  
<sup>主要由 gpt-5.6、KimiK3 和 glm-5.2 协作生产</sup>

## Star History

<a href="https://www.star-history.com/?repos=Moyf%2Fmoys-asr-workflow&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Moyf/moys-asr-workflow&type=date&theme=dark&legend=top-left&sealed_token=_PToQhiZM0l9HWee443BsVO_Ent6c7W9XhetqS-GqzovCVxrR29_zMbiDuhZOZRQd-vsEaQhUvF262_K7KBgtzedaZ57WJ3lkgoDR9-QocuvQgw7_My_06JAPfChISW3AJh0fgpAJWVAi1XXRPs7I-5caimIiS5mNri_lJrB_9iBnvtf8_vvhtgAh-fL" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Moyf/moys-asr-workflow&type=date&legend=top-left&sealed_token=_PToQhiZM0l9HWee443BsVO_Ent6c7W9XhetqS-GqzovCVxrR29_zMbiDuhZOZRQd-vsEaQhUvF262_K7KBgtzedaZ57WJ3lkgoDR9-QocuvQgw7_My_06JAPfChISW3AJh0fgpAJWVAi1XXRPs7I-5caimIiS5mNri_lJrB_9iBnvtf8_vvhtgAh-fL" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Moyf/moys-asr-workflow&type=date&legend=top-left&sealed_token=_PToQhiZM0l9HWee443BsVO_Ent6c7W9XhetqS-GqzovCVxrR29_zMbiDuhZOZRQd-vsEaQhUvF262_K7KBgtzedaZ57WJ3lkgoDR9-QocuvQgw7_My_06JAPfChISW3AJh0fgpAJWVAi1XXRPs7I-5caimIiS5mNri_lJrB_9iBnvtf8_vvhtgAh-fL" />
 </picture>
</a>

## 许可证

本项目采用 [AGPL-3.0-only](LICENSE)。若你修改后把它作为网络服务提供给用户，AGPL 通常要求向这些用户提供对应的修改后源码；发布前请自行确认你的合规义务。
