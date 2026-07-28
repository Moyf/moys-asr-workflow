"""本地 Qwen3-ASR / faster-whisper 转写模块。

封装模型生命周期管理和转写流程，供 Launcher GUI 或 CLI 调用。
"""

from __future__ import annotations

import gc
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path

from maw.utils import (
    SPLIT_GAP_MS,
    SPLIT_MAX_CHARS,
    SPLIT_MIN_CHARS,
    extract_audio,
    generate_srt,
    get_duration_sec,
    parse_duration,
    repair_nonpositive_duration_segments,
    split_words_to_segments,
)


# ===== 常量 =====

MAX_LENGTH_LIMIT_SEC = 3600 * 4  # P2-9: length_limit 上限 4 小时
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = ROOT / "results"


# ===== 模型管理 =====

# Qwen 本地模型的语言代码 → 全名映射（模型要求全名如 "English" 而非 "en"）
_QWEN_LANG_MAP = {
    "zh": "Chinese", "yue": "Cantonese", "en": "English",
    "ar": "Arabic", "de": "German", "fr": "French", "es": "Spanish",
    "pt": "Portuguese", "id": "Indonesian", "it": "Italian",
    "ko": "Korean", "ru": "Russian", "th": "Thai", "vi": "Vietnamese",
    "ja": "Japanese", "tr": "Turkish", "hi": "Hindi", "ms": "Malay",
    "nl": "Dutch", "sv": "Swedish", "da": "Danish", "fi": "Finnish",
    "pl": "Polish", "cs": "Czech", "fil": "Filipino", "fa": "Persian",
    "el": "Greek", "ro": "Romanian", "hu": "Hungarian", "mk": "Macedonian",
}


class QwenModelHandle:
    """Qwen3-ASR 模型句柄（线程安全）。"""

    def __init__(self):
        self._model = None
        self._lock = threading.Lock()
        self._cancel_event = threading.Event()
        self._model_size: str = ""
        self._loading = False
        self._error = ""

    @property
    def loaded(self) -> bool:
        return self._model is not None

    @property
    def model_size(self) -> str:
        return self._model_size

    @property
    def loading(self) -> bool:
        return self._loading

    @property
    def error(self) -> str:
        return self._error

    def get_status(self) -> dict:
        with self._lock:
            return {
                "loaded": self._model is not None,
                "loading": self._loading,
                "error": self._error,
                "model_size": self._model_size,
            }

    def load(self, model_size: str = "0.6B", device: str | None = None,
             progress_cb=None) -> None:
        """加载 Qwen3-ASR 模型。device=None 自动检测 CUDA。"""
        with self._lock:
            if self._loading:
                raise RuntimeError("Model is already loading")
            if self._model is not None:
                raise RuntimeError("Model is already loaded, unload first")
            self._loading = True
            self._model_size = model_size
            self._error = ""
        try:
            if progress_cb:
                progress_cb("importing qwen_asr...")
            from qwen_asr import Qwen3ASRModel  # type: ignore[import-untyped]

            if device is None:
                import torch
                device = "cuda" if torch.cuda.is_available() else "cpu"

            # 先尝试本地路径，再回退 HuggingFace
            import torch
            dtype = torch.float16 if "cuda" in device else torch.float32
            model_path = str(ROOT / "models" / f"Qwen3-ASR-{model_size}")
            if not Path(model_path).exists():
                model_path = f"Qwen/Qwen3-ASR-{model_size}"
            aligner_path = str(ROOT / "models" / "Qwen3-ForcedAligner-0.6B")
            if not Path(aligner_path).exists():
                aligner_path = "Qwen/Qwen3-ForcedAligner-0.6B"

            if progress_cb:
                progress_cb(f"loading Qwen3-ASR-{model_size} ({device})...")
            model = Qwen3ASRModel.from_pretrained(
                model_path,
                dtype=dtype,
                device_map=device,
                forced_aligner=aligner_path,
                forced_aligner_kwargs=dict(dtype=dtype, device_map=device),
                max_inference_batch_size=1,
                max_new_tokens=256,
            )
            with self._lock:
                self._model = model
                self._loading = False
            if progress_cb:
                progress_cb("loaded")
        except Exception as e:
            with self._lock:
                self._model = None
                self._loading = False
                self._error = str(e)
            raise

    def unload(self) -> None:
        """卸载模型并释放 GPU 内存。"""
        with self._lock:
            model = self._model
            self._model = None
            self._model_size = ""
            self._error = ""
        if model is not None:
            try:
                import torch
                if hasattr(model, "to"):
                    model.to("cpu")
                del model
                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

    def get_model(self):
        """返回模型引用（线程安全）。"""
        with self._lock:
            return self._model

    @property
    def cancel_event(self) -> threading.Event:
        return self._cancel_event

    def cancel(self) -> None:
        """标记取消当前转写。"""
        self._cancel_event.set()

    def reset_cancel(self) -> None:
        """重置取消标记（新转写前调用）。"""
        self._cancel_event.clear()


class WhisperModelHandle:
    """faster-whisper 模型句柄（线程安全）。"""

    def __init__(self):
        self._model = None
        self._lock = threading.Lock()
        self._cancel_event = threading.Event()
        self._loading = False
        self._error = ""

    @property
    def loaded(self) -> bool:
        return self._model is not None

    @property
    def loading(self) -> bool:
        return self._loading

    @property
    def error(self) -> str:
        return self._error

    def get_status(self) -> dict:
        with self._lock:
            return {
                "loaded": self._model is not None,
                "loading": self._loading,
                "error": self._error,
            }

    def load(self, model_path: str | Path | None = None,
             device: str | None = None, progress_cb=None) -> None:
        """加载 faster-whisper-large-v3 模型。"""
        with self._lock:
            if self._loading:
                raise RuntimeError("Model is already loading")
            if self._model is not None:
                raise RuntimeError("Model is already loaded, unload first")
            self._loading = True
            self._error = ""
        try:
            if model_path is None:
                model_path = self._find_model_path()
            if progress_cb:
                progress_cb(f"loading faster-whisper ({device or 'cpu'})...")

            if device is None:
                import torch
                device = "cuda" if torch.cuda.is_available() else "cpu"

            from faster_whisper import WhisperModel  # type: ignore[import-untyped]
            compute_type = "float16" if device == "cuda" else "int8"
            cpu_threads_val = min(os.cpu_count() or 4, 8)
            model = WhisperModel(
                str(model_path),
                device=device,
                compute_type=compute_type,
                num_workers=1,
                cpu_threads=cpu_threads_val,
            )
            with self._lock:
                self._model = model
                self._loading = False
            if progress_cb:
                progress_cb("loaded")
        except Exception as e:
            with self._lock:
                self._model = None
                self._loading = False
                self._error = str(e)
            raise

    def unload(self) -> None:
        with self._lock:
            model = self._model
            self._model = None
            self._error = ""
        if model is not None:
            try:
                del model
                gc.collect()
            except Exception:
                pass

    def get_model(self):
        with self._lock:
            return self._model

    def cancel(self) -> None:
        self._cancel_event.set()

    def reset_cancel(self) -> None:
        self._cancel_event.clear()

    @property
    def cancel_event(self) -> threading.Event:
        return self._cancel_event

    @staticmethod
    def _find_model_path() -> str:
        """自动查找 faster-whisper 模型路径。"""
        fw_base = ROOT / "models" / "faster-whisper-large-v3" / "snapshots"
        snapshots = sorted(fw_base.glob("*")) if fw_base.exists() else []
        if snapshots:
            return str(snapshots[0])
        alt = ROOT / "models" / "faster-whisper-large-v3"
        if alt.exists():
            return str(alt)
        return "faster-whisper-large-v3"  # 让 WhisperModel 自己去下载


# ===== 转写流程 =====

class TranscriptionResult:
    """一次转写的完整输出。"""

    def __init__(self, segments: list[dict], srt_content: str,
                 model_tag: str, detected_language: str,
                 duration_sec: float, elapsed_sec: float):
        self.segments = segments
        self.srt_content = srt_content
        self.model_tag = model_tag
        self.detected_language = detected_language
        self.duration_sec = duration_sec
        self.elapsed_sec = elapsed_sec

    @property
    def speed_tag(self) -> str:
        if self.elapsed_sec > 0 and self.duration_sec > 0:
            return f"{self.duration_sec / self.elapsed_sec:.1f}x"
        return "na"

    def to_json(self, media_path: str) -> dict:
        return {
            "media": media_path,
            "language": self.detected_language,
            "model": self.model_tag,
            "segments": [
                {"start": s["start"], "end": s["end"], "text": s["text"],
                 "items": s.get("items", [])}
                for s in self.segments
            ],
        }


def transcribe_qwen(
    input_path: str,
    model_handle: QwenModelHandle,
    *,
    language: str | None = None,
    keep_punct: bool = True,
    length_limit: str | None = None,
    hotwords: list[str] | None = None,
    progress_cb=None,
) -> TranscriptionResult:
    """使用已加载的 Qwen3-ASR 模型进行转写。

    Args:
        input_path: 音频/视频文件路径
        model_handle: 已加载的 QwenModelHandle
        language: 语言代码或 None（自动检测）
        keep_punct: 是否保留标点
        length_limit: 时长限制（如 "10m"）
        hotwords: 热词列表
        progress_cb: 进度回调 (message: str) -> None

    Returns:
        TranscriptionResult
    """
    model_handle.reset_cancel()

    def log(msg: str):
        if progress_cb:
            progress_cb(msg)

    import shutil

    inp = Path(input_path)
    is_video = inp.suffix.lower() in {".mp4", ".mkv", ".avi", ".mov",
                                       ".wmv", ".flv", ".webm", ".ts", ".m4v"}

    with tempfile.TemporaryDirectory() as tmpdir:
        if is_video:
            audio_path = str(Path(tmpdir) / "audio.wav")
            extract_audio(input_path, audio_path)
            log("audio extracted")
        else:
            audio_path = str(Path(tmpdir) / inp.name)
            shutil.copy2(input_path, audio_path)

        duration = get_duration_sec(audio_path)
        m, s = divmod(int(duration), 60)
        log(f"duration: {m}m{s}s")

        if length_limit:
            limit_sec = parse_duration(length_limit)
            # P2-9: length_limit 上限校验
            if limit_sec > MAX_LENGTH_LIMIT_SEC:
                raise ValueError(
                    f"length_limit exceeds {MAX_LENGTH_LIMIT_SEC}s "
                    f"({MAX_LENGTH_LIMIT_SEC // 3600}h)"
                )
            if limit_sec < duration:
                limited = str(Path(tmpdir) / "audio_limited.wav")
                subprocess.run(
                    ["ffmpeg", "-i", audio_path, "-t", str(limit_sec),
                     "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
                     "-y", limited],
                    check=True, capture_output=True,
                )
                audio_path = limited
                duration = limit_sec
                log(f"trimmed to {limit_sec}s")

        # 热词
        context_str = " ".join(hotwords) if hotwords else ""
        if context_str:
            log(f"hotwords: {context_str}")

        model = model_handle.get_model()
        if model is None:
            raise RuntimeError("Qwen model not loaded")

        # 将语言代码转为 Qwen 模型要求的全名
        qwen_lang = _QWEN_LANG_MAP.get(language or "", "")
        lang_param = qwen_lang if qwen_lang else None
        log(f"language: {lang_param or 'auto'}")
        t0 = time.perf_counter()

        results = model.transcribe(
            audio=[audio_path],
            language=[lang_param] if lang_param else [None],
            context=[context_str] if context_str else None,
            return_time_stamps=True,
        )

        elapsed = time.perf_counter() - t0

        if model_handle.cancel_event.is_set():
            raise RuntimeError("Cancelled by user")

        if not results:
            raise RuntimeError("No result from model")
        result = results[0]
        log(f"language: {result.language}")
        log(f"transcribe time: {elapsed:.1f}s")

        # 转标准 items 格式
        items = []
        if result.time_stamps:
            for ts in result.time_stamps:
                items.append({
                    "text": ts.text,
                    "start": int(ts.start_time * 1000),
                    "end": int(ts.end_time * 1000),
                })

        if not items:
            segments = [{"start": 0, "end": int(duration * 1000),
                         "text": result.text}]
        else:
            segments = split_words_to_segments(
                items, SPLIT_MAX_CHARS, SPLIT_MIN_CHARS, SPLIT_GAP_MS
            )
            segments = repair_nonpositive_duration_segments(segments)

        if not keep_punct:
            for seg in segments:
                seg["text"] = seg["text"].rstrip("，。")
                seg_items = seg.get("items")
                if seg_items:
                    k = len(seg_items) - 1
                    while k >= 0:
                        seg_items[k]["text"] = seg_items[k]["text"].rstrip("，。")
                        if seg_items[k]["text"]:
                            break
                        k -= 1

        srt_content = generate_srt(segments)
        model_size = model_handle.model_size
        model_tag = f"qwen3-asr-local-{model_size}" if model_size else "qwen3-asr-local"

        log(f"segments: {len(segments)}")
        log("DONE")

    return TranscriptionResult(
        segments=segments,
        srt_content=srt_content,
        model_tag=model_tag,
        detected_language=result.language or "",
        duration_sec=duration,
        elapsed_sec=elapsed,
    )


def transcribe_whisper(
    input_path: str,
    model_handle: WhisperModelHandle,
    *,
    language: str | None = None,
    progress_cb=None,
) -> TranscriptionResult:
    """使用已加载的 faster-whisper 模型进行转写。"""
    model_handle.reset_cancel()

    def log(msg: str):
        if progress_cb:
            progress_cb(msg)

    import shutil

    inp = Path(input_path)
    is_video = inp.suffix.lower() in {".mp4", ".mkv", ".avi", ".mov",
                                       ".wmv", ".flv", ".webm", ".ts", ".m4v"}

    with tempfile.TemporaryDirectory() as tmpdir:
        if is_video:
            audio_path = str(Path(tmpdir) / "audio.wav")
            extract_audio(input_path, audio_path)
            log("audio extracted")
        else:
            audio_path = str(Path(tmpdir) / inp.name)
            shutil.copy2(input_path, audio_path)

        duration = get_duration_sec(audio_path)
        m, s = divmod(int(duration), 60)
        log(f"duration: {m}m{s}s")

        model = model_handle.get_model()
        if model is None:
            raise RuntimeError("Whisper model not loaded")

        log("transcribing...")
        t0 = time.perf_counter()

        segments, info = model.transcribe(
            audio_path,
            language=language if language else None,
            beam_size=5,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
        )

        elapsed = time.perf_counter() - t0

        if model_handle.cancel_event.is_set():
            raise RuntimeError("Cancelled by user")

        seg_list = list(segments)
        detected_lang = info.language if info else ""
        log(f"language: {detected_lang}")
        log(f"segments: {len(seg_list)}")
        log(f"transcribe time: {elapsed:.1f}s")

        if not seg_list:
            raise RuntimeError("No transcription result")

        # P2-6: Whisper 输出已是句子级，不二次切分
        segments_out = [
            {"start": int(s.start * 1000), "end": int(s.end * 1000),
             "text": s.text.strip(), "items": []}
            for s in seg_list
        ]
        if not segments_out:
            segments_out = [{"start": 0, "end": int(duration * 1000),
                             "text": "", "items": []}]

        srt_content = generate_srt(segments_out)
        log(f"segments: {len(segments_out)}")
        log("DONE")

    return TranscriptionResult(
        segments=segments_out,
        srt_content=srt_content,
        model_tag="faster-whisper-large-v3",
        detected_language=detected_lang or language or "en",
        duration_sec=duration,
        elapsed_sec=elapsed,
    )


# ===== 文件输出 =====

def write_output_files(
    result: TranscriptionResult,
    media_path: str,
    out_dir: str | Path = DEFAULT_OUTPUT_DIR,
    *,
    generate_html: bool = True,
    progress_cb=None,
) -> Path:
    """写入 SRT/JSON 文件，返回 json_path。"""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    inp = Path(media_path)
    ts_prefix = datetime.now().strftime("%y%m%d%H%M")
    base = out_dir / f"[{ts_prefix}]{inp.stem}.{result.model_tag}.{result.speed_tag}"

    srt_path = base.with_suffix(".srt")
    srt_path.write_text(result.srt_content, encoding="utf-8")
    if progress_cb:
        progress_cb(f"SRT: {srt_path}")

    json_data = result.to_json(str(inp))
    json_path = base.with_suffix(".json")
    json_path.write_text(
        json.dumps(json_data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if progress_cb:
        progress_cb(f"JSON: {json_path}")

    if generate_html:
        try:
            edit_script = ROOT / "edit.py"
            if edit_script.exists():
                result = subprocess.run(
                    [sys.executable, str(edit_script), str(json_path)],
                    cwd=str(ROOT),
                    capture_output=True, text=True, timeout=120,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                )
                if result.returncode != 0:
                    err = (result.stderr or result.stdout or "").strip()[:300]
                    if progress_cb:
                        progress_cb(f"edit.py exited with code {result.returncode}: {err}")
                else:
                    if progress_cb:
                        progress_cb(f"HTML: {base.with_suffix('.edit.html')}")
                html_path = base.with_suffix(".edit.html")
                if not html_path.exists() and progress_cb:
                    progress_cb("warning: edit.html not generated (edit.py may have failed)")
        except subprocess.TimeoutExpired:
            if progress_cb:
                progress_cb("edit.py timed out (waveform generation too slow)")
        except Exception as ex:
            if progress_cb:
                progress_cb(f"edit.py failed: {ex}")

    return json_path
