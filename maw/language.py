"""Shared language and transcription-granularity conventions.

ASR providers use a mixture of ISO codes, English names, and localized names.
Keep the project-facing value stable while leaving provider-specific request
formats to their adapters.
"""

from __future__ import annotations

from collections.abc import Sequence


LANGUAGE_SOURCES = frozenset({"detected", "hint", "inferred", "unknown"})
SPLIT_MODES = frozenset({"continuous", "word"})
TIMESTAMP_GRANULARITIES = frozenset({"char", "word", "segment", "unknown"})

# Shared subtitle defaults.  Keep these outside a provider adapter so the
# Launcher, local CLI, and cloud/local segmentation paths expose one contract.
DEFAULT_MAX_WORDS = 13
DEFAULT_MIN_WORDS = 3

# These are the languages for which MAW counts text as a continuous character
# stream. Korean remains word-mode: Hangul has whitespace-separated words and
# the existing auto splitter treats it as a western/word language.
CONTINUOUS_LANGUAGE_CODES = frozenset({"zh", "yue", "ja"})


_LANGUAGE_ALIASES = {
    # Chinese and Cantonese
    "zh": "zh",
    "zh-cn": "zh",
    "zh-hans": "zh",
    "zh-sg": "zh",
    "zh-tw": "zh",
    "zh-hant": "zh",
    "cmn": "zh",
    "chi": "zh",
    "zho": "zh",
    "chinese": "zh",
    "mandarin": "zh",
    "zhongwen": "zh",
    "中文": "zh",
    "汉语": "zh",
    "汉語": "zh",
    "普通话": "zh",
    "普通話": "zh",
    "yue": "yue",
    "yue-cn": "yue",
    "cantonese": "yue",
    "粵語": "yue",
    "粤语": "yue",
    "广东话": "yue",
    "廣東話": "yue",
    # East Asian languages
    "ja": "ja",
    "jpn": "ja",
    "japanese": "ja",
    "日本語": "ja",
    "日语": "ja",
    "ko": "ko",
    "kor": "ko",
    "korean": "ko",
    "한국어": "ko",
    "韩语": "ko",
    "韓語": "ko",
    # Common Latin/Cyrillic language codes and provider names
    "en": "en", "eng": "en", "english": "en", "英语": "en", "英文": "en",
    "ar": "ar", "ara": "ar", "arabic": "ar", "阿拉伯语": "ar",
    "cs": "cs", "ces": "cs", "czech": "cs",
    "da": "da", "dan": "da", "danish": "da",
    "nl": "nl", "nld": "nl", "dutch": "nl",
    "fi": "fi", "fin": "fi", "finnish": "fi",
    "fr": "fr", "fra": "fr", "fre": "fr", "french": "fr", "法语": "fr",
    "de": "de", "deu": "de", "ger": "de", "german": "de", "德语": "de",
    "el": "el", "ell": "el", "gre": "el", "greek": "el",
    "hi": "hi", "hin": "hi", "hindi": "hi",
    "hu": "hu", "hun": "hu", "hungarian": "hu",
    "id": "id", "ind": "id", "indonesian": "id",
    "it": "it", "ita": "it", "italian": "it",
    "ms": "ms", "msa": "ms", "may": "ms", "malay": "ms",
    "mk": "mk", "mkd": "mk", "macedonian": "mk",
    "fa": "fa", "fas": "fa", "per": "fa", "persian": "fa",
    "pl": "pl", "pol": "pl", "polish": "pl",
    "pt": "pt", "por": "pt", "portuguese": "pt",
    "ro": "ro", "ron": "ro", "rum": "ro", "romanian": "ro",
    "ru": "ru", "rus": "ru", "russian": "ru", "俄语": "ru",
    "es": "es", "spa": "es", "spanish": "es", "西班牙语": "es",
    "sv": "sv", "swe": "sv", "swedish": "sv",
    "th": "th", "tha": "th", "thai": "th",
    "tr": "tr", "tur": "tr", "turkish": "tr",
    "vi": "vi", "vie": "vi", "vietnamese": "vi",
    "uk": "uk", "ukr": "uk", "ukrainian": "uk",
    "he": "he", "heb": "he", "hebrew": "he",
    "no": "no", "nor": "no", "norwegian": "no",
    "sk": "sk", "slk": "sk", "slo": "sk", "slovak": "sk",
    "sl": "sl", "slv": "sl", "slovenian": "sl",
    "bg": "bg", "bul": "bg", "bulgarian": "bg",
    "hr": "hr", "hrv": "hr", "croatian": "hr",
    "ca": "ca", "cat": "ca", "catalan": "ca",
    "et": "et", "est": "et", "estonian": "et",
    "lv": "lv", "lav": "lv", "latvian": "lv",
    "lt": "lt", "lit": "lt", "lithuanian": "lt",
    # Other languages exposed by the Soniox/Launcher registries.  Filipino is
    # stored as ``fil`` even when a provider calls it ``tl``/Tagalog.
    "af": "af", "afr": "af", "afrikaans": "af",
    "sq": "sq", "sqi": "sq", "albanian": "sq",
    "az": "az", "aze": "az", "azerbaijani": "az",
    "eu": "eu", "eus": "eu", "basque": "eu",
    "be": "be", "bel": "be", "belarusian": "be",
    "bn": "bn", "ben": "bn", "bengali": "bn",
    "bs": "bs", "bos": "bs", "bosnian": "bs",
    "fil": "fil", "tl": "fil", "tgl": "fil", "filipino": "fil", "tagalog": "fil",
    "gl": "gl", "glg": "gl", "galician": "gl",
    "gu": "gu", "guj": "gu", "gujarati": "gu",
    "is": "is", "isl": "is", "ice": "is", "icelandic": "is",
    "kn": "kn", "kan": "kn", "kannada": "kn",
    "kk": "kk", "kaz": "kk", "kazakh": "kk",
    "ml": "ml", "mal": "ml", "malayalam": "ml",
    "mr": "mr", "mar": "mr", "marathi": "mr",
    "pa": "pa", "pan": "pa", "punjabi": "pa",
    "sr": "sr", "srp": "sr", "serbian": "sr",
    "sw": "sw", "swa": "sw", "swahili": "sw",
    "ta": "ta", "tam": "ta", "tamil": "ta",
    "te": "te", "tel": "te", "telugu": "te",
    "ur": "ur", "urd": "ur", "urdu": "ur",
    "cy": "cy", "cym": "cy", "welsh": "cy", "威尔士语": "cy",
}


def normalize_language_code(value: object) -> str:
    """Return a canonical ISO-style code, or ``""`` when it is unknown."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    # Soniox and Launcher hints can contain a comma-separated list.  A single
    # project language records the first usable code; provider hint handling
    # remains responsible for preserving the full list where needed.
    raw = raw.split(",", 1)[0].strip()
    key = raw.casefold().replace("_", "-")
    if key in {"auto", "automatic", "detect", "detected", "unknown", "none", "自动", "自动识别"}:
        return ""
    direct = _LANGUAGE_ALIASES.get(key)
    if direct:
        return direct
    base = key.split("-", 1)[0]
    return _LANGUAGE_ALIASES.get(base, "")


def infer_language_code(text: str) -> str:
    """Infer only script-identifiable languages; do not call all Latin text English."""
    if any("\uac00" <= char <= "\ud7af" for char in text):
        return "ko"
    if any(
        "\u3040" <= char <= "\u30ff"
        or "\u31f0" <= char <= "\u31ff"
        for char in text
    ):
        return "ja"
    if any(
        "\u3400" <= char <= "\u4dbf"
        or "\u4e00" <= char <= "\u9fff"
        or "\uf900" <= char <= "\ufaff"
        for char in text
    ):
        return "zh"
    return ""


def resolve_language(
    raw_language: object,
    language_hint: object = None,
    text: str = "",
) -> tuple[str, str]:
    """Resolve output language and provenance in priority order."""
    detected = normalize_language_code(raw_language)
    if detected:
        return detected, "detected"
    hinted = normalize_language_code(language_hint)
    if hinted:
        return hinted, "hint"
    inferred = infer_language_code(text)
    if inferred:
        return inferred, "inferred"
    return "", "unknown"


def split_mode_for_language(language: object) -> str:
    """Map a known language to MAW's continuous or word counting mode."""
    code = normalize_language_code(language)
    if not code:
        return ""
    return "continuous" if code in CONTINUOUS_LANGUAGE_CODES else "word"


def split_mode_for_text(text: str, language: object = None) -> str:
    """Choose a safe default when a provider did not return language metadata."""
    explicit = split_mode_for_language(language)
    if explicit:
        return explicit
    inferred = infer_language_code(text)
    if inferred:
        return split_mode_for_language(inferred)
    # Latin-script text is not labelled as English, but its subtitle units are
    # still words by default. This is a split-mode decision, not language ID.
    return "word"


def is_space_separated_language(language: object) -> bool:
    code = normalize_language_code(language)
    if not code:
        return False
    # A known language that is not in the continuous-script set uses words for
    # the purpose of spacing/counting. Keep this derived from the split-mode
    # contract so newly supported word languages cannot silently concatenate.
    return code not in CONTINUOUS_LANGUAGE_CODES


def timestamp_granularity_for_items(
    items: Sequence[object],
    split_mode: str,
    *,
    explicit_items: bool = True,
    has_segments: bool = False,
) -> str:
    """Describe item granularity without claiming precision for fallback items."""
    if not items or not explicit_items:
        return "segment" if has_segments else "unknown"
    return "char" if split_mode == "continuous" else "word"


__all__ = [
    "CONTINUOUS_LANGUAGE_CODES",
    "DEFAULT_MAX_WORDS",
    "DEFAULT_MIN_WORDS",
    "LANGUAGE_SOURCES",
    "SPLIT_MODES",
    "TIMESTAMP_GRANULARITIES",
    "infer_language_code",
    "is_space_separated_language",
    "normalize_language_code",
    "resolve_language",
    "split_mode_for_language",
    "split_mode_for_text",
    "timestamp_granularity_for_items",
]
