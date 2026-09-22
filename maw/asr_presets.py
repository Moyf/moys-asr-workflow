"""Portable, model-independent Launcher recognition presets (no credentials)."""

from pathlib import Path
import json

SCHEMA = "maw.asr-preset.v1"
TEXT_FIELDS = (
    "localDevice", "fireRedPunc", "recognitionAlignmentModel", "language",
    "qwenAudioContext", "qwenAudioHotwordsMode", "qwenAudioHotwords",
    "qwenAudioHotwordsFile", "qwenAudioHotwordWeight", "sonioxContextGeneral",
    "sonioxContextText", "sonioxContextTerms", "sonioxContextTranslationTerms",
    "openaiPrompt", "openaiKeywords", "maxLen", "minLen", "maxWords", "minWords", "gapSplit",
)
BOOL_FIELDS = ("speakerColors", "generateSpectral", "debugRaw", "testRun")


def validate_options(options: object) -> dict:
    if not isinstance(options, dict) or set(options) != set(TEXT_FIELDS + BOOL_FIELDS):
        raise ValueError("Invalid preset fields")
    for key in TEXT_FIELDS:
        if not isinstance(options[key], str) or len(options[key]) > 500_000:
            raise ValueError(f"Invalid preset field: {key}")
    for key in BOOL_FIELDS:
        if type(options[key]) is not bool:
            raise ValueError(f"Invalid preset field: {key}")
    for key, values in {
        "localDevice": ("auto", "cpu", "cuda"),
        "fireRedPunc": ("none", "ct-punc"),
        "qwenAudioHotwordsMode": ("text", "file"),
        "qwenAudioHotwordWeight": ("1", "2", "3", "4", "5", "50"),
    }.items():
        if options[key] not in values:
            raise ValueError(f"Invalid preset field: {key}")
    for key in ("maxLen", "minLen", "maxWords", "minWords", "gapSplit"):
        if options[key] and (not options[key].isascii() or not options[key].isdigit()):
            raise ValueError(f"Invalid preset field: {key}")
    return dict(options)


def read_preset(path: Path) -> dict:
    if path.stat().st_size > 4_000_000:
        raise ValueError("Preset is too large")
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict) or data.get("schema") != SCHEMA:
        raise ValueError("Unsupported preset format")
    return validate_options(data.get("options"))


def write_preset(path: Path, options: object) -> None:
    data = {"schema": SCHEMA, "options": validate_options(options)}
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if len(text.encode("utf-8")) > 4_000_000:
        raise ValueError("Preset is too large")
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        stream.write(text)
