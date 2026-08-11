# pyright: reportAny=false

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Final


ROOT: Final = Path(__file__).resolve().parents[1]


def default_env_path() -> Path:
    """Return the writable GUI configuration path for the current platform."""
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Moy" / "MAW" / ".env"
    return ROOT / ".env"


DEFAULT_ENV_PATH: Final = default_env_path()
EXAMPLE_ENV_PATH: Final = ROOT / ".env.example"
QWEN_AUDIO_MODEL_ID: Final = "qwen-audio-3.0-asr-flash-filetrans"
QWEN3_ASR_MODEL_ID: Final = "qwen3-asr-flash-filetrans"
# qwen-audio-3.0 是最新发布的模型，作为各入口默认；旧 qwen3-asr 置底保留（后续可能移除）。
DEFAULT_MODEL_ID: Final = QWEN_AUDIO_MODEL_ID


@dataclass(frozen=True, slots=True)
class ModelConfig:
    id: str
    label: str
    env_key: str
    note: str = ""
    supports_speaker: bool = False
    supports_context: bool = False
    supports_hotwords: bool = False
    supports_vocabulary: bool = False
    languages: tuple[tuple[str, str], ...] = ()
    kind: str = "cloud"
    engine: str = ""
    model_ref: str = ""
    required_model_refs: tuple[str, ...] = ()
    requires_runtime: tuple[str, ...] = ()
    # 上游缓存中的实际模型 ID；当引擎用简写加载（如 FunASR paraformer-zh）
    # 而缓存目录使用完整 ID 时，扫描器靠它定位已下载的模型。
    cache_refs: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ProviderConfig:
    id: str
    label: str
    key_url: str
    models: tuple[ModelConfig, ...]
    regions: tuple[tuple[str, str], ...]
    languages: tuple[tuple[str, str], ...]
    supports_speaker: bool = False
    multi_language: bool = False
    # 常用语言代码；为空表示不过滤（全部视为常用）。
    # 开启「显示相对小众的语言」前，GUI 只展示这些。
    common_languages: tuple[str, ...] = ()
    kind: str = "cloud"
    requires_api_key: bool = True


@dataclass(frozen=True, slots=True)
class EffectiveConfig:
    api_key: str
    region: str
    workspace_id: str
    language: str
    gui_lang: str
    sticker_dir: str
    show_rare_langs: bool = False
    last_model: str | None = None
    last_language: str | None = None
    model_cache_root: str = ""


REGIONS: Final[tuple[tuple[str, str], ...]] = (
    ("beijing", "北京（华北 2，默认）"),
    ("singapore", "新加坡（需要 Workspace ID）"),
)

# Qwen-ASR（qwen3-asr-flash 系列）官方文档：language 只能指定一个语种，
# 不指定即自动识别；取值如下（28 种 + 自动）。
# https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference
LANGUAGES: Final[tuple[tuple[str, str], ...]] = (
    ("", "自动识别"),
    ("zh", "中文 / Mandarin"),
    ("yue", "粤语 / Cantonese"),
    ("en", "英语 / English"),
    ("ja", "日语 / Japanese"),
    ("de", "德语 / German"),
    ("ko", "韩语 / Korean"),
    ("ru", "俄语 / Russian"),
    ("fr", "法语 / French"),
    ("pt", "葡萄牙语 / Portuguese"),
    ("ar", "阿拉伯语 / Arabic"),
    ("it", "意大利语 / Italian"),
    ("es", "西班牙语 / Spanish"),
    ("hi", "印地语 / Hindi"),
    ("id", "印尼语 / Indonesian"),
    ("th", "泰语 / Thai"),
    ("tr", "土耳其语 / Turkish"),
    ("uk", "乌克兰语 / Ukrainian"),
    ("vi", "越南语 / Vietnamese"),
    ("cs", "捷克语 / Czech"),
    ("da", "丹麦语 / Danish"),
    ("fil", "菲律宾语 / Filipino"),
    ("fi", "芬兰语 / Finnish"),
    ("is", "冰岛语 / Icelandic"),
    ("ms", "马来语 / Malay"),
    ("no", "挪威语 / Norwegian"),
    ("pl", "波兰语 / Polish"),
    ("sv", "瑞典语 / Swedish"),
)

FUNASR_LANGUAGES: Final[tuple[tuple[str, str], ...]] = (
    ("", "自动识别"),
    ("zh", "中文 / Chinese"),
    ("yue", "粤语 / Cantonese"),
    ("en", "英语 / English"),
    ("ja", "日语 / Japanese"),
    ("ko", "韩语 / Korean"),
    ("vi", "越南语 / Vietnamese"),
    ("th", "泰语 / Thai"),
    ("id", "印尼语 / Indonesian"),
    ("ms", "马来语 / Malay"),
    ("tl", "菲律宾语 / Filipino"),
    ("hi", "印地语 / Hindi"),
    ("ar", "阿拉伯语 / Arabic"),
    ("fr", "法语 / French"),
    ("de", "德语 / German"),
    ("es", "西班牙语 / Spanish"),
    ("pt", "葡萄牙语 / Portuguese"),
    ("ru", "俄语 / Russian"),
    ("it", "意大利语 / Italian"),
    ("nl", "荷兰语 / Dutch"),
    ("sv", "瑞典语 / Swedish"),
    ("da", "丹麦语 / Danish"),
    ("fi", "芬兰语 / Finnish"),
    ("no", "挪威语 / Norwegian"),
    ("el", "希腊语 / Greek"),
    ("pl", "波兰语 / Polish"),
    ("cs", "捷克语 / Czech"),
    ("hu", "匈牙利语 / Hungarian"),
    ("ro", "罗马尼亚语 / Romanian"),
    ("bg", "保加利亚语 / Bulgarian"),
    ("hr", "克罗地亚语 / Croatian"),
    ("sk", "斯洛伐克语 / Slovak"),
)

SENSEVOICE_LANGUAGES: Final[tuple[tuple[str, str], ...]] = (
    ("", "自动识别"),
    ("zh", "中文 / Chinese"),
    ("yue", "粤语 / Cantonese"),
    ("en", "英语 / English"),
    ("ja", "日语 / Japanese"),
    ("ko", "韩语 / Korean"),
)

FUN_ASR_NANO_LANGUAGES: Final[tuple[tuple[str, str], ...]] = (
    ("", "自动识别"),
    ("zh", "中文 / Chinese"),
    ("yue", "粤语 / Cantonese"),
    ("en", "英语 / English"),
    ("ja", "日语 / Japanese"),
)

# 关闭「显示相对小众的语言」时，Qwen 保留 9 种、Soniox 保留 8 种常用语言。
# Qwen 的空代码（自动识别）也始终显示。
QWEN_COMMON_LANGUAGES: Final[tuple[str, ...]] = (
    "", "zh", "yue", "en", "ja", "ko", "fr", "de", "es", "ru",
)

# Soniox 官方文档：language_hints 是列表（可多选，仅偏向不限制），
# 不提供即自动识别；支持 60 种语言（2026-07 文档）。
# https://soniox.com/docs/stt/concepts/supported-languages
SONIOX_LANGUAGES: Final[tuple[tuple[str, str], ...]] = (
    ("zh", "中文 / Mandarin"),
    ("en", "英语 / English"),
    ("ja", "日语 / Japanese"),
    ("ko", "韩语 / Korean"),
    ("af", "南非荷兰语 / Afrikaans"),
    ("sq", "阿尔巴尼亚语 / Albanian"),
    ("ar", "阿拉伯语 / Arabic"),
    ("az", "阿塞拜疆语 / Azerbaijani"),
    ("eu", "巴斯克语 / Basque"),
    ("be", "白俄罗斯语 / Belarusian"),
    ("bn", "孟加拉语 / Bengali"),
    ("bs", "波斯尼亚语 / Bosnian"),
    ("bg", "保加利亚语 / Bulgarian"),
    ("ca", "加泰罗尼亚语 / Catalan"),
    ("hr", "克罗地亚语 / Croatian"),
    ("cs", "捷克语 / Czech"),
    ("da", "丹麦语 / Danish"),
    ("nl", "荷兰语 / Dutch"),
    ("et", "爱沙尼亚语 / Estonian"),
    ("fi", "芬兰语 / Finnish"),
    ("fr", "法语 / French"),
    ("gl", "加利西亚语 / Galician"),
    ("de", "德语 / German"),
    ("el", "希腊语 / Greek"),
    ("gu", "古吉拉特语 / Gujarati"),
    ("he", "希伯来语 / Hebrew"),
    ("hi", "印地语 / Hindi"),
    ("hu", "匈牙利语 / Hungarian"),
    ("id", "印尼语 / Indonesian"),
    ("it", "意大利语 / Italian"),
    ("kn", "卡纳达语 / Kannada"),
    ("kk", "哈萨克语 / Kazakh"),
    ("lv", "拉脱维亚语 / Latvian"),
    ("lt", "立陶宛语 / Lithuanian"),
    ("mk", "马其顿语 / Macedonian"),
    ("ms", "马来语 / Malay"),
    ("ml", "马拉雅拉姆语 / Malayalam"),
    ("mr", "马拉地语 / Marathi"),
    ("no", "挪威语 / Norwegian"),
    ("fa", "波斯语 / Persian"),
    ("pl", "波兰语 / Polish"),
    ("pt", "葡萄牙语 / Portuguese"),
    ("pa", "旁遮普语 / Punjabi"),
    ("ro", "罗马尼亚语 / Romanian"),
    ("ru", "俄语 / Russian"),
    ("sr", "塞尔维亚语 / Serbian"),
    ("sk", "斯洛伐克语 / Slovak"),
    ("sl", "斯洛文尼亚语 / Slovenian"),
    ("es", "西班牙语 / Spanish"),
    ("sw", "斯瓦希里语 / Swahili"),
    ("sv", "瑞典语 / Swedish"),
    ("tl", "菲律宾语 / Tagalog"),
    ("ta", "泰米尔语 / Tamil"),
    ("te", "泰卢固语 / Telugu"),
    ("th", "泰语 / Thai"),
    ("tr", "土耳其语 / Turkish"),
    ("uk", "乌克兰语 / Ukrainian"),
    ("ur", "乌尔都语 / Urdu"),
    ("vi", "越南语 / Vietnamese"),
    ("cy", "威尔士语 / Welsh"),
)

# Soniox 60 种里的常用语言（GUI 默认只显示这些；开关打开后显示全部）
SONIOX_COMMON_LANGUAGES: Final[tuple[str, ...]] = (
    "zh", "en", "ja", "ko", "fr", "de", "es", "ru",
)

QWEN_MODELS: Final[tuple[ModelConfig, ...]] = (
    ModelConfig(
        id=QWEN_AUDIO_MODEL_ID,
        label="qwen-audio-3.0-asr（热词 / 上下文）",
        env_key="DASHSCOPE_API_KEY",
        note="支持即时热词、上下文与说话人分离",
        supports_speaker=True,
        supports_context=True,
        supports_hotwords=True,
        supports_vocabulary=True,
        languages=FUNASR_LANGUAGES,
    ),
    ModelConfig(
        id="fun-asr",
        label="fun-asr（支持说话人）",
        env_key="DASHSCOPE_API_KEY",
        note="支持说话人分离与词级时间戳",
        supports_speaker=True,
        languages=FUNASR_LANGUAGES,
    ),
    ModelConfig(
        id=QWEN3_ASR_MODEL_ID,
        label="qwen3-asr（准确率更高）",
        env_key="DASHSCOPE_API_KEY",
        languages=LANGUAGES,
    ),
)

SONIOX_MODELS: Final[tuple[ModelConfig, ...]] = (
    ModelConfig(
        id="stt-async-v5",
        label="Soniox Async STT（v5）",
        env_key="SONIOX_API_KEY",
        supports_speaker=True,
        languages=SONIOX_LANGUAGES,
    ),
)

LOCAL_MODELS: Final[tuple[ModelConfig, ...]] = (
    ModelConfig(
        id="qwen3-asr-local",
        label="Qwen3-ASR 0.6B（推荐）",
        env_key="",
        note="本地运行；首次准备会加载 Qwen3-ASR 与 Forced Aligner",
        languages=LANGUAGES,
        kind="local",
        engine="qwen-asr",
        model_ref="Qwen/Qwen3-ASR-0.6B",
        required_model_refs=("Qwen/Qwen3-ForcedAligner-0.6B",),
        requires_runtime=("qwen_asr", "torch"),
    ),
    ModelConfig(
        id="qwen3-asr-1.7b-local",
        label="Qwen3-ASR 1.7B",
        env_key="",
        note="更高识别质量；与 0.6B 共用 Qwen3 Forced Aligner",
        languages=LANGUAGES,
        kind="local",
        engine="qwen-asr",
        model_ref="Qwen/Qwen3-ASR-1.7B",
        required_model_refs=("Qwen/Qwen3-ForcedAligner-0.6B",),
        requires_runtime=("qwen_asr", "torch"),
    ),
    ModelConfig(
        id="fun-asr-nano-local",
        label="Fun-ASR-Nano 2512（GPU）",
        env_key="",
        note="LLM-ASR 路线；默认配合 FSMN-VAD，中英日及中文方言，建议使用 CUDA",
        languages=FUN_ASR_NANO_LANGUAGES,
        kind="local",
        engine="funasr",
        model_ref="FunAudioLLM/Fun-ASR-Nano-2512",
        requires_runtime=("funasr", "torchaudio"),
    ),
    ModelConfig(
        id="funasr-local",
        label="FunASR paraformer-zh",
        env_key="",
        note="本地运行；使用 FunASR 上游模型缓存",
        languages=FUNASR_LANGUAGES,
        kind="local",
        engine="funasr",
        model_ref="paraformer-zh",
        requires_runtime=("funasr", "torchaudio"),
        # FunASR model zoo 把 paraformer-zh 解析为这个 ModelScope ID；
        # GUI 不能导入 FunASR，扫描缓存时需要显式的映射。
        cache_refs=("iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",),
    ),
    ModelConfig(
        id="sensevoice-small-local",
        label="SenseVoice Small",
        env_key="",
        note="多语种本地识别；默认配合 FSMN-VAD，CPU/GPU 都可运行",
        languages=SENSEVOICE_LANGUAGES,
        kind="local",
        engine="funasr",
        model_ref="iic/SenseVoiceSmall",
        requires_runtime=("funasr", "torchaudio"),
    ),
)

PROVIDERS: Final[tuple[ProviderConfig, ...]] = (
    ProviderConfig(
        id="qwen",
        label="阿里云百炼（QwenASR / FunASR）",
        key_url="https://help.aliyun.com/zh/model-studio/get-api-key",
        models=QWEN_MODELS,
        regions=REGIONS,
        languages=LANGUAGES,
        supports_speaker=True,
        common_languages=QWEN_COMMON_LANGUAGES,
    ),
    ProviderConfig(
        id="soniox",
        label="Soniox STT",
        key_url="https://console.soniox.com",
        models=SONIOX_MODELS,
        regions=(),
        languages=SONIOX_LANGUAGES,
        supports_speaker=True,
        multi_language=True,
        common_languages=SONIOX_COMMON_LANGUAGES,
    ),
    ProviderConfig(
        id="local",
        label="本地模型（Beta）",
        key_url="",
        models=LOCAL_MODELS,
        regions=(),
        languages=LANGUAGES,
        supports_speaker=False,
        common_languages=QWEN_COMMON_LANGUAGES,
        kind="local",
        requires_api_key=False,
    ),
)

MODELS: Final[tuple[ModelConfig, ...]] = PROVIDERS[0].models
LEGACY_MODELS: Final[tuple[ModelConfig, ...]] = tuple(model for model in QWEN_MODELS if model.id == QWEN3_ASR_MODEL_ID)


def load_env(path: Path = DEFAULT_ENV_PATH) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return values
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def save_env(path: Path, updates: Mapping[str, str]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    text = _initial_env_text(target)
    lines = text.splitlines()
    seen: set[str] = set()
    output: list[str] = []
    for line in lines:
        key = _env_key(line)
        if key is not None and key in updates:
            output.append(f"{key}={updates[key]}")
            seen.add(key)
        else:
            output.append(line)
    for key, value in updates.items():
        if key not in seen:
            output.append(f"{key}={value}")
    _ = target.write_text("\n".join(output).rstrip("\n") + "\n", encoding="utf-8", newline="\n")


def effective_config(path: Path = DEFAULT_ENV_PATH, environ: Mapping[str, str] | None = None) -> EffectiveConfig:
    file_values = load_env(path)
    env = environ or os.environ

    def pick(key: str, default: str = "") -> str:
        return env.get(key) or file_values.get(key, default)

    def pick_optional(key: str) -> str | None:
        if key in env:
            return env[key]
        if key in file_values:
            return file_values[key]
        return None

    return EffectiveConfig(
        api_key=pick(MODELS[0].env_key),
        region=pick("DASHSCOPE_REGION", "beijing").lower() or "beijing",
        workspace_id=pick("DASHSCOPE_WORKSPACE_ID"),
        language=pick("DASHSCOPE_DEFAULT_LANGUAGE"),
        gui_lang=_gui_language(pick("MAW_GUI_LANG", "zh")),
        sticker_dir=pick("STICKER_DIR"),
        show_rare_langs=pick("MAW_GUI_SHOW_RARE_LANGS").strip().lower() in ("1", "true", "yes", "on"),
        last_model=pick_optional("MAW_GUI_LAST_MODEL"),
        last_language=pick_optional("MAW_GUI_LAST_LANGUAGE"),
        model_cache_root=pick("MAW_MODEL_CACHE_ROOT").strip(),
    )


def model_by_label(label: str) -> ModelConfig:
    for provider in PROVIDERS:
        for model in provider.models:
            if label == model.label or label == model.id:
                return model
    return MODELS[0]


def provider_by_id(provider_id: str) -> ProviderConfig:
    for provider in PROVIDERS:
        if provider.id == provider_id:
            return provider
    return PROVIDERS[0]


def provider_for_model(model_id: str) -> ProviderConfig:
    for provider in PROVIDERS:
        if any(model.id == model_id for model in provider.models):
            return provider
    return PROVIDERS[0]


def api_key_for_provider(provider_id: str, path: Path = DEFAULT_ENV_PATH, environ: Mapping[str, str] | None = None) -> str:
    """按供应商读取 API Key（系统环境变量优先，其次 .env）。"""
    provider = provider_by_id(provider_id)
    if not provider.requires_api_key:
        return ""
    if not provider.models:
        return ""
    env_key = provider.models[0].env_key
    env = environ or os.environ
    return env.get(env_key) or load_env(path).get(env_key, "")


def region_label(region_id: str) -> str:
    for value, label in REGIONS:
        if value == region_id:
            return label
    return REGIONS[0][1]


def language_label(language_id: str) -> str:
    for value, label in LANGUAGES:
        if value == language_id:
            return label
    return LANGUAGES[0][1]


def value_from_label(options: tuple[tuple[str, str], ...], label: str) -> str:
    for value, option_label in options:
        if label == option_label or label == value:
            return value
    return options[0][0]


def masked_secret(secret: str) -> str:
    value = secret.strip()
    if not value:
        return ""
    if len(value) <= 4:
        return "…" + value
    return f"{value[:3]}…{value[-4:]}"


def _initial_env_text(path: Path) -> str:
    if path.exists():
        return path.read_text(encoding="utf-8")
    example = path.with_name(".env.example")
    if example.exists():
        return example.read_text(encoding="utf-8")
    if EXAMPLE_ENV_PATH.exists():
        return EXAMPLE_ENV_PATH.read_text(encoding="utf-8")
    return ""


def _env_key(line: str) -> str | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return None
    key, _value = stripped.split("=", 1)
    return key.strip()


def _gui_language(value: str) -> str:
    return "en" if value.strip().lower() == "en" else "zh"
