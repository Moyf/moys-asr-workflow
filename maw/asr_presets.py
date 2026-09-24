"""Portable, model-independent Launcher recognition presets (no credentials)."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import uuid
from pathlib import Path

from send2trash import send2trash

SCHEMA = "maw.asr-preset.v1"
MAX_PRESET_BYTES = 4_000_000
MAX_MIGRATION_BYTES = 16_000_000
MAX_DESCRIPTION_LENGTH = 2_000
MAX_NAME_LENGTH = 120
TEXT_FIELDS = (
    "localDevice", "fireRedPunc", "recognitionAlignmentModel", "language", "promptContext",
    "qwenAudioHotwordsMode", "qwenAudioHotwords",
    "qwenAudioHotwordsFile", "qwenAudioHotwordWeight", "sonioxContextGeneral",
    "sonioxContextTerms", "sonioxContextTranslationTerms",
    "openaiKeywords", "maxLen", "minLen", "maxWords", "minWords", "gapSplit",
)
BOOL_FIELDS = ("speakerColors", "generateSpectral", "debugRaw", "testRun", "qwenAudioKeepDialect")
# Form inputs that share the single "promptContext" preset value across providers.
SHARED_PROMPT_INPUTS = ("openaiPrompt", "qwenAudioContext", "sonioxContextText")
_INVALID_NAME_CHARS = frozenset('<>:"/\\|?*')
_RESERVED_WINDOWS_NAMES = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


def validate_preset_name(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("Preset name must be text")
    name = value.strip()
    if not name or name in {".", ".."} or len(name) > MAX_NAME_LENGTH:
        raise ValueError("Preset name is empty or too long")
    if name.casefold().endswith(".json"):
        raise ValueError("Enter the name without the .json extension")
    if any(character in _INVALID_NAME_CHARS or ord(character) < 32 for character in name):
        raise ValueError("Preset name contains characters that are not allowed in a filename")
    if name.endswith((".", " ")) or name.split(".", 1)[0].casefold() in _RESERVED_WINDOWS_NAMES:
        raise ValueError("Preset name is not valid on Windows")
    return name


def validate_description(value: object) -> str:
    if not isinstance(value, str) or len(value) > MAX_DESCRIPTION_LENGTH or "\x00" in value:
        raise ValueError("Invalid preset description")
    return value.replace("\r\n", "\n").replace("\r", "\n")


def validate_options(options: object) -> dict:
    # Presets saved before Qwen-Audio 3.1 used the default dialect behavior.
    if isinstance(options, dict):
        options = {"qwenAudioKeepDialect": False, **options}
        # Older presets stored per-provider prompt/context fields; they all map
        # to the single shared promptContext value now.
        options["promptContext"] = "\n".join(dict.fromkeys(
            value.strip()
            for value in (options.get("promptContext", ""), *(options.get(key, "") for key in SHARED_PROMPT_INPUTS))
            if isinstance(value, str) and value.strip()
        ))
        for key in SHARED_PROMPT_INPUTS:
            options.pop(key, None)
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


def _read_document(path: Path) -> dict:
    if path.is_symlink() or not path.is_file():
        raise ValueError("Preset must be a regular file")
    if path.stat().st_size > MAX_PRESET_BYTES:
        raise ValueError("Preset is too large")
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict) or data.get("schema") != SCHEMA:
        raise ValueError("Unsupported preset format")
    return {
        "options": validate_options(data.get("options")),
        "description": validate_description(data.get("description", "")),
    }


def read_preset(path: Path) -> dict:
    """Read a preset's options while retaining the original public helper API."""
    return _read_document(Path(path))["options"]


def read_preset_document(path: Path) -> dict:
    return _read_document(Path(path))


def write_preset(path: Path, options: object, description: str = "", *, overwrite: bool = True) -> None:
    target = Path(path)
    data = {
        "schema": SCHEMA,
        "description": validate_description(description),
        "options": validate_options(options),
    }
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if len(text.encode("utf-8")) > MAX_PRESET_BYTES:
        raise ValueError("Preset is too large")
    if target.is_symlink():
        raise ValueError("Preset must not be a symbolic link")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline="\n",
            prefix=".asr-preset-", suffix=".tmp", dir=target.parent, delete=False,
        ) as stream:
            temporary = Path(stream.name)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        if overwrite:
            os.replace(temporary, target)
        else:
            try:
                os.link(temporary, target)
            except FileExistsError:
                raise
            except OSError:
                if os.name != "nt":
                    raise
                os.rename(temporary, target)
            if temporary.exists():
                temporary.unlink()
    except BaseException:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
        raise


def preset_path(directory: Path, name: object, *, allow_missing: bool = False) -> Path:
    root = Path(directory).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Preset folder is not a directory")
    safe_name = validate_preset_name(name)
    candidate = root / f"{safe_name}.json"
    if candidate.is_symlink():
        raise ValueError("Symbolic links are not allowed in the preset folder")
    if candidate.exists() and not candidate.is_file():
        raise ValueError("Preset path is not a file")
    if not allow_missing and not candidate.is_file():
        raise FileNotFoundError(f"Preset not found: {safe_name}")
    return candidate


def _find_name_collision(directory: Path, name: str, *, exclude: Path | None = None) -> str:
    wanted = f"{name}.json".casefold()
    excluded = exclude.name.casefold() if exclude is not None else ""
    for item in directory.iterdir():
        if item.name.casefold() == wanted and item.name.casefold() != excluded:
            return item.name
    return ""


def create_preset(directory: Path, name: object, options: object, description: object = "") -> str:
    root = Path(directory).expanduser().resolve(strict=True)
    safe_name = validate_preset_name(name)
    clean_description = validate_description(description)
    safe_options = validate_options(options)
    collision = _find_name_collision(root, safe_name)
    if collision:
        raise FileExistsError(f"A preset named {collision[:-5]} already exists")
    target = preset_path(root, safe_name, allow_missing=True)
    write_preset(target, safe_options, clean_description, overwrite=False)
    return safe_name


def list_presets(directory: Path) -> list[dict]:
    root = Path(directory).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Preset folder is not a directory")
    items: list[dict] = []
    for path in root.iterdir():
        if path.suffix.casefold() != ".json":
            continue
        if path.is_dir() and not path.is_symlink():
            continue
        name = path.name[:-5]
        entry = {"name": name, "description": "", "modified": 0, "valid": False, "detail": ""}
        try:
            if path.is_symlink() or not path.is_file():
                raise ValueError("Not a regular file; symbolic links are not supported")
            validate_preset_name(name)
            document = read_preset_document(path)
            entry["description"] = document["description"]
            entry["valid"] = True
        except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
            entry["detail"] = str(error) or "Invalid preset file"
        try:
            entry["modified"] = path.lstat().st_mtime
        except OSError:
            pass
        items.append(entry)
    return sorted(items, key=lambda item: (not item["valid"], item["name"].casefold(), item["name"]))


def inspect_migration(source: Path, destination: Path) -> dict:
    """Validate a flat migration and report files and case-insensitive conflicts."""
    source_root = Path(source).expanduser().resolve(strict=True)
    destination_root = Path(destination).expanduser().resolve(strict=True)
    if not source_root.is_dir() or not destination_root.is_dir():
        raise ValueError("Both preset paths must be directories")
    if source_root == destination_root:
        return {"source": str(source_root), "files": [], "invalid": [], "conflicts": []}
    sources = sorted(
        (path for path in source_root.iterdir() if path.suffix.casefold() == ".json"),
        key=lambda path: path.name.casefold(),
    )
    invalid: list[dict[str, str]] = []
    safe_sources: list[Path] = []
    for path in sources:
        if path.is_symlink() or not path.is_file():
            invalid.append({"name": path.name, "detail": "Not a regular file; symbolic links are not supported"})
            continue
        try:
            validate_preset_name(path.name[:-5])
        except ValueError as error:
            invalid.append({"name": path.name, "detail": str(error)})
            continue
        if path.stat().st_size > MAX_MIGRATION_BYTES:
            invalid.append({"name": path.name, "detail": "Preset is too large to migrate"})
            continue
        safe_sources.append(path)
    names = [path.name.casefold() for path in safe_sources]
    if len(names) != len(set(names)):
        raise ValueError("The source folder contains names that differ only by letter case")
    existing = {path.name.casefold(): path.name for path in destination_root.iterdir()}
    conflicts = [path.name for path in safe_sources if path.name.casefold() in existing]
    return {
        "source": str(source_root),
        "files": [path.name for path in safe_sources],
        "invalid": invalid,
        "conflicts": conflicts,
    }


def migrate_presets(source: Path, destination: Path, *, recycle_sources: bool = True) -> dict:
    """Copy all direct JSON files without overwriting; optionally recycle originals."""
    plan = inspect_migration(source, destination)
    source_root = Path(plan["source"])
    destination_root = Path(destination).expanduser().resolve(strict=True)
    if source_root == destination_root:
        return {"migrated": [], "sourceRemaining": []}
    if plan["conflicts"]:
        raise FileExistsError("Preset name conflicts: " + ", ".join(plan["conflicts"]))
    sources = [source_root / name for name in plan["files"]]

    staged: list[tuple[Path, Path]] = []
    published: list[Path] = []
    try:
        for source_path in sources:
            with tempfile.NamedTemporaryFile(
                mode="wb", prefix=".asr-migrate-", suffix=".tmp", dir=destination_root, delete=False,
            ) as stream:
                temporary = Path(stream.name)
                staged.append((temporary, destination_root / source_path.name))
                with source_path.open("rb") as source_stream:
                    shutil.copyfileobj(source_stream, stream)
                stream.flush()
                os.fsync(stream.fileno())
        for temporary, target in staged:
            # Exclusive creation prevents a concurrent save from being overwritten.
            with target.open("xb") as stream:
                published.append(target)
                with temporary.open("rb") as source_stream:
                    shutil.copyfileobj(source_stream, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
            shutil.copystat(temporary, target, follow_symlinks=False)
    except BaseException:
        for target in published:
            try:
                send2trash(str(target))
            except OSError:
                pass
        raise
    finally:
        for temporary, _target in staged:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    source_remaining: list[str] = [entry["name"] for entry in plan.get("invalid", [])]
    if recycle_sources:
        for source_path in sources:
            try:
                send2trash(str(source_path))
            except OSError:
                source_remaining.append(source_path.name)
    return {"migrated": [path.name for path in sources], "sourceRemaining": source_remaining}


def rename_preset(directory: Path, old_name: object, new_name: object, description: object) -> str:
    """Rename a library item while retaining its saved recognition options."""
    old_path = preset_path(directory, old_name)
    document = read_preset_document(old_path)
    safe_new_name = validate_preset_name(new_name)
    clean_description = validate_description(description)
    root = old_path.parent
    collision = _find_name_collision(root, safe_new_name, exclude=old_path)
    if collision:
        raise FileExistsError(f"A preset named {collision[:-5]} already exists")
    new_path = root / f"{safe_new_name}.json"
    if old_path.name == new_path.name:
        write_preset(old_path, document["options"], clean_description)
        return safe_new_name

    if old_path.name.casefold() == new_path.name.casefold():
        temporary = root / f".asr-rename-{uuid.uuid4().hex}.tmp"
        old_path.rename(temporary)
        try:
            temporary.rename(new_path)
            try:
                write_preset(new_path, document["options"], clean_description)
            except BaseException:
                new_path.rename(old_path)
                raise
        except BaseException:
            if temporary.exists() and not old_path.exists():
                temporary.rename(old_path)
            raise
        return safe_new_name

    write_preset(new_path, document["options"], clean_description, overwrite=False)
    try:
        old_path.unlink()
    except OSError:
        try:
            send2trash(str(new_path))
        except OSError:
            pass
        raise
    return safe_new_name
