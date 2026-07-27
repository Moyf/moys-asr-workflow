# pyright: reportAny=false

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Final


ROOT: Final = Path(__file__).resolve().parents[1]
DEFAULT_ENV_PATH: Final = ROOT / ".env"
EXAMPLE_ENV_PATH: Final = ROOT / ".env.example"
DEFAULT_MODEL_ID: Final = "qwen3-asr-flash-filetrans"


@dataclass(frozen=True, slots=True)
class ModelConfig:
    id: str
    label: str
    env_key: str
    note: str = ""


@dataclass(frozen=True, slots=True)
class EffectiveConfig:
    api_key: str
    region: str
    workspace_id: str
    language: str
    gui_lang: str


MODELS: Final[tuple[ModelConfig, ...]] = (
    ModelConfig(
        id=DEFAULT_MODEL_ID,
        label="Qwen3 ASR（文件转写）",
        env_key="DASHSCOPE_API_KEY",
    ),
)

REGIONS: Final[tuple[tuple[str, str], ...]] = (
    ("beijing", "北京（华北 2，默认）"),
    ("singapore", "新加坡（需要 Workspace ID）"),
)

LANGUAGES: Final[tuple[tuple[str, str], ...]] = (
    ("", "自动识别"),
    ("zh", "中文 / Mandarin"),
    ("yue", "粤语 / Cantonese"),
    ("en", "英语 / English"),
    ("ja", "日语 / Japanese"),
    ("ko", "韩语 / Korean"),
    ("de", "德语 / German"),
    ("fr", "法语 / French"),
)


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

    return EffectiveConfig(
        api_key=pick(MODELS[0].env_key),
        region=pick("DASHSCOPE_REGION", "beijing").lower() or "beijing",
        workspace_id=pick("DASHSCOPE_WORKSPACE_ID"),
        language=pick("DASHSCOPE_DEFAULT_LANGUAGE"),
        gui_lang=_gui_language(pick("MAW_GUI_LANG", "zh")),
    )


def model_by_label(label: str) -> ModelConfig:
    for model in MODELS:
        if label == model.label or label == model.id:
            return model
    return MODELS[0]


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
