# pyright: reportAny=false, reportUnannotatedClassAttribute=false, reportUnusedCallResult=false

from __future__ import annotations

import os
import queue
import threading
import tkinter as tk
import webbrowser
from collections.abc import Callable
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from typing import final

from maw.gui_workflow import TranscriptionRequest, TranscriptionResult, default_srt_path, run_transcription


GuiEvent = tuple[str, str | TranscriptionResult]


@final
class InputValidationError(ValueError):
    """Raised when required GUI input is absent or invalid."""


class GuiApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("Moy's ASR Workflow")
        self.events: queue.Queue[GuiEvent] = queue.Queue()
        self.cancel_event = threading.Event()
        self.worker: threading.Thread | None = None
        self.result_paths: dict[str, Path] = {}
        self.media_var = tk.StringVar()
        self.output_var = tk.StringVar()
        self.language_var = tk.StringVar()
        self.api_key_var = tk.StringVar(value=os.environ.get("DASHSCOPE_API_KEY", ""))
        self.length_var = tk.StringVar()
        self.region_var = tk.StringVar()
        self.status_var = tk.StringVar(value="Ready")
        self._build()

    def run(self) -> None:
        self.root.after(100, self._poll_events)
        self.root.mainloop()

    def _build(self) -> None:
        frame = ttk.Frame(self.root, padding=12)
        frame.grid(row=0, column=0, sticky="nsew")
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        frame.columnconfigure(1, weight=1)
        self._row(frame, 0, "Media", self.media_var, self._choose_media)
        self._row(frame, 1, "SRT output", self.output_var, self._choose_output)
        self._entry(frame, 2, "API key", self.api_key_var, show="*")
        self._entry(frame, 3, "Language", self.language_var)
        self._entry(frame, 4, "Length limit", self.length_var)
        self._entry(frame, 5, "Region", self.region_var)
        self.start_button = ttk.Button(frame, text="Generate SRT + JSON + HTML", command=self._start)
        self.start_button.grid(row=6, column=0, columnspan=2, sticky="ew", pady=(8, 4))
        self.cancel_button = ttk.Button(frame, text="Cancel", command=self._cancel, state="disabled")
        self.cancel_button.grid(row=6, column=2, sticky="ew", padx=(6, 0), pady=(8, 4))
        self.log = tk.Text(frame, height=12, width=80, state="disabled")
        self.log.grid(row=7, column=0, columnspan=3, sticky="nsew")
        frame.rowconfigure(7, weight=1)
        output_frame = ttk.Frame(frame)
        output_frame.grid(row=8, column=0, columnspan=3, sticky="ew", pady=(8, 0))
        ttk.Button(output_frame, text="Open output folder", command=self._open_folder).pack(side="left")
        ttk.Button(output_frame, text="Open editor HTML", command=self._open_html).pack(side="left", padx=6)
        ttk.Label(frame, textvariable=self.status_var).grid(row=9, column=0, columnspan=3, sticky="w", pady=(6, 0))

    def _row(self, frame: ttk.Frame, row: int, label: str, var: tk.StringVar, command: Callable[[], None]) -> None:
        self._entry(frame, row, label, var)
        ttk.Button(frame, text="Browse", command=command).grid(row=row, column=2, sticky="ew", padx=(6, 0), pady=3)

    def _entry(self, frame: ttk.Frame, row: int, label: str, var: tk.StringVar, *, show: str | None = None) -> None:
        ttk.Label(frame, text=label).grid(row=row, column=0, sticky="w", pady=3)
        entry = ttk.Entry(frame, textvariable=var, show=show or "")
        entry.grid(row=row, column=1, sticky="ew", pady=3)

    def _choose_media(self) -> None:
        chosen = filedialog.askopenfilename(title="Choose audio or video")
        if chosen:
            self.media_var.set(chosen)
            if not self.output_var.get().strip():
                self.output_var.set(str(default_srt_path(Path(chosen))))

    def _choose_output(self) -> None:
        initial = self.output_var.get().strip() or str(default_srt_path(Path(self.media_var.get() or "output.mp3")))
        chosen = filedialog.asksaveasfilename(title="Choose SRT output", initialfile=Path(initial).name, defaultextension=".srt")
        if chosen:
            self.output_var.set(chosen)

    def _start(self) -> None:
        try:
            request = self._request()
        except InputValidationError as exc:
            messagebox.showerror("Cannot start", str(exc))
            return
        self.cancel_event.clear()
        self._set_running(True)
        self._append("Starting transcription...")
        self.worker = threading.Thread(target=self._worker_main, args=(request,), daemon=True)
        self.worker.start()

    def _request(self) -> TranscriptionRequest:
        media = Path(self.media_var.get().strip()).expanduser()
        output = Path(self.output_var.get().strip()).expanduser()
        if not media.exists():
            raise InputValidationError("Choose an existing media file.")
        if not output.name:
            raise InputValidationError("Choose an explicit SRT output path.")
        return TranscriptionRequest(
            media_path=media,
            srt_path=output,
            language=self.language_var.get().strip(),
            api_key=self.api_key_var.get().strip(),
            length_limit=self.length_var.get().strip(),
            region=self.region_var.get().strip(),
        )

    def _worker_main(self, request: TranscriptionRequest) -> None:
        try:
            result = run_transcription(request, on_event=lambda text: self.events.put(("log", text)), cancel_event=self.cancel_event)
        except Exception as exc:  # noqa: BROAD_EXCEPT_OK - worker boundary reports failures to Tk.
            self.events.put(("error", str(exc)))
            return
        self.events.put(("done", result))

    def _poll_events(self) -> None:
        while True:
            try:
                kind, payload = self.events.get_nowait()
            except queue.Empty:
                break
            if kind == "log":
                self._append(str(payload))
            elif kind == "error":
                self._set_running(False)
                self.status_var.set("Failed")
                self._append(str(payload))
                messagebox.showerror("Transcription failed", str(payload))
            elif kind == "done":
                if not isinstance(payload, TranscriptionResult):
                    continue
                self._set_running(False)
                self.result_paths = {"srt": payload.srt_path, "json": payload.json_path}
                if payload.html_path:
                    self.result_paths["html"] = payload.html_path
                self.status_var.set("Done")
                self._append("Done.")
        self.root.after(100, self._poll_events)

    def _cancel(self) -> None:
        self.cancel_event.set()
        self.status_var.set("Cancelling...")

    def _set_running(self, running: bool) -> None:
        self.start_button.configure(state="disabled" if running else "normal")
        self.cancel_button.configure(state="normal" if running else "disabled")
        self.status_var.set("Running..." if running else self.status_var.get())

    def _append(self, message: str) -> None:
        self.log.configure(state="normal")
        self.log.insert("end", message + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _open_folder(self) -> None:
        path = self.result_paths.get("srt") or Path(self.output_var.get().strip())
        if path:
            webbrowser.open(Path(path).parent.resolve().as_uri())

    def _open_html(self) -> None:
        html_path = self.result_paths.get("html")
        if html_path and html_path.exists():
            webbrowser.open(html_path.resolve().as_uri())
        else:
            messagebox.showinfo("No HTML", "Editor HTML is not available yet.")


def run_app() -> None:
    GuiApp(tk.Tk()).run()
