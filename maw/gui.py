# pyright: reportAny=false, reportArgumentType=false, reportMissingImports=false, reportUnannotatedClassAttribute=false, reportUnusedCallResult=false, reportUnknownMemberType=false, reportUnknownVariableType=false

from __future__ import annotations

import queue
import subprocess
import threading
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import messagebox, ttk
from typing import final

import sv_ttk

from maw.gui_config import LANGUAGES, MODELS, REGIONS, effective_config, language_label, masked_secret, region_label, save_env, value_from_label
from maw import gui_forms as forms
from maw.gui_i18n import STRINGS
from maw.gui_controls import choose_json, choose_media, choose_output
from maw.gui_language import apply_language, sync_workspace_state
from maw.gui_platform import set_window_icon
from maw.gui_request import RequestValidationError, build_request, save_settings
from maw.gui_server import poll_editor_server, start_editor_server, stop_editor_server
from maw.gui_workflow import TranscriptionRequest, TranscriptionResult, run_transcription


GuiEvent = tuple[str, str | TranscriptionResult]


class GuiApp:
    """Mutable Tk application controller; Tk widgets are inherently stateful."""

    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title(STRINGS["zh"]["app_title"])
        self.root.minsize(760, 680)
        set_window_icon(self.root)
        self.events: queue.Queue[GuiEvent] = queue.Queue()
        self.cancel_event = threading.Event()
        self.worker: threading.Thread | None = None
        self.server_process: subprocess.Popen[str] | None = None
        self.result_paths: dict[str, Path] = {}
        config = effective_config()
        self.lang = config.gui_lang
        self.media_var = tk.StringVar()
        self.output_var = tk.StringVar()
        self.model_var = tk.StringVar(value=MODELS[0].label)
        self.region_var = tk.StringVar(value=region_label(config.region))
        self.workspace_var = tk.StringVar(value=config.workspace_id)
        self.language_var = tk.StringVar(value=language_label(config.language))
        self.api_key_var = tk.StringVar(value=config.api_key)
        self.length_var = tk.StringVar()
        self.json_var = tk.StringVar()
        self.port_var = tk.StringVar(value="8765")
        self.status_var = tk.StringVar(value=self._t("ready"))
        self.api_status_var = tk.StringVar(value=self._key_status(config.api_key))
        self.i18n_widgets: dict[str, tk.Widget] = {}
        self._build()
        self._apply_language()
        self._sync_workspace_state()
        self.root.protocol("WM_DELETE_WINDOW", self._close)

    def run(self) -> None:
        self.root.after(100, self._poll_events)
        self.root.after(1000, self._poll_server)
        self.root.mainloop()

    def _build(self) -> None:
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        shell = ttk.Frame(self.root, padding=14)
        shell.grid(row=0, column=0, sticky="nsew")
        shell.columnconfigure(0, weight=1)
        shell.rowconfigure(5, weight=1)

        header = ttk.Frame(shell)
        header.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        header.columnconfigure(0, weight=1)
        ttk.Label(header, text="MAW", font=("TkDefaultFont", 18, "bold")).grid(row=0, column=0, sticky="w")
        self.lang_button = ttk.Button(header, command=self._toggle_language, width=10)
        self.lang_button.grid(row=0, column=1, sticky="e")

        media_frame = forms.labelframe(shell, "media_output", 1, self.i18n_widgets)
        forms.path_row(media_frame, 0, "media", self.media_var, self._choose_media, self.i18n_widgets)
        forms.path_row(media_frame, 1, "srt_output", self.output_var, self._choose_output, self.i18n_widgets)

        settings_frame = forms.labelframe(shell, "recognition", 2, self.i18n_widgets)
        self.model_combo = forms.combo(settings_frame, 0, "model", self.model_var, [model.label for model in MODELS], self.i18n_widgets)
        self.region_combo = forms.combo(settings_frame, 1, "region", self.region_var, [label for _value, label in REGIONS], self.i18n_widgets)
        self.region_combo.bind("<<ComboboxSelected>>", lambda _event: self._sync_workspace_state())
        self.workspace_label = forms.label(settings_frame, 2, "workspace", self.i18n_widgets)
        self.workspace_entry = ttk.Entry(settings_frame, textvariable=self.workspace_var)
        self.workspace_entry.grid(row=2, column=1, sticky="ew", pady=3)
        self.workspace_hint = ttk.Label(settings_frame, wraplength=520)
        self.workspace_hint.grid(row=2, column=2, sticky="w", padx=(6, 0), pady=3)
        self.language_combo = forms.combo(settings_frame, 3, "language", self.language_var, [label for _value, label in LANGUAGES], self.i18n_widgets)
        forms.entry(settings_frame, 4, "length_limit", self.length_var, self.i18n_widgets)
        self.length_hint = ttk.Label(settings_frame)
        self.length_hint.grid(row=4, column=2, sticky="w", padx=(6, 0), pady=3)

        key_frame = forms.labelframe(shell, "api_key", 3, self.i18n_widgets)
        forms.entry(key_frame, 0, "key", self.api_key_var, self.i18n_widgets, show="*")
        self.save_key_button = ttk.Button(key_frame, command=self._save_settings)
        self.save_key_button.grid(row=0, column=2, sticky="ew", padx=(6, 0), pady=3)
        ttk.Label(key_frame, textvariable=self.api_status_var).grid(row=1, column=1, columnspan=2, sticky="w", pady=(0, 3))

        server_frame = forms.labelframe(shell, "server", 4, self.i18n_widgets)
        forms.path_row(server_frame, 0, "json_project", self.json_var, self._choose_json, self.i18n_widgets)
        forms.label(server_frame, 1, "port", self.i18n_widgets)
        self.port_spin = ttk.Spinbox(server_frame, from_=1, to=65535, textvariable=self.port_var, width=8)
        self.port_spin.grid(row=1, column=1, sticky="w", pady=3)
        self.server_button = ttk.Button(server_frame, command=self._toggle_server)
        self.server_button.grid(row=1, column=2, sticky="ew", padx=(6, 0), pady=3)

        log_frame = forms.labelframe(shell, "logs", 5, self.i18n_widgets)
        log_frame.rowconfigure(0, weight=1)
        self.log = tk.Text(log_frame, height=10, width=80, state="disabled", wrap="word")
        self.log.grid(row=0, column=0, columnspan=3, sticky="nsew")
        self.progress = ttk.Progressbar(log_frame, mode="indeterminate")
        self.progress.grid(row=1, column=0, columnspan=3, sticky="ew", pady=(8, 0))

        actions = ttk.Frame(shell)
        actions.grid(row=6, column=0, sticky="ew", pady=(10, 0))
        actions.columnconfigure(0, weight=1)
        self.start_button = ttk.Button(actions, command=self._start)
        self.start_button.grid(row=0, column=0, sticky="ew")
        self.cancel_button = ttk.Button(actions, command=self._cancel, state="disabled")
        self.cancel_button.grid(row=0, column=1, sticky="ew", padx=(6, 0))
        self.folder_button = ttk.Button(actions, command=self._open_folder)
        self.folder_button.grid(row=0, column=2, sticky="ew", padx=(6, 0))
        self.html_button = ttk.Button(actions, command=self._open_html)
        self.html_button.grid(row=0, column=3, sticky="ew", padx=(6, 0))
        ttk.Label(shell, textvariable=self.status_var).grid(row=7, column=0, sticky="w", pady=(8, 0))

    def _choose_media(self) -> None:
        choose_media(self.media_var, self.output_var, self._t("choose_media"))

    def _choose_output(self) -> None:
        choose_output(self.media_var, self.output_var, self._t("choose_output"))

    def _choose_json(self) -> None:
        choose_json(self.json_var, self._t("choose_json"))

    def _start(self) -> None:
        try:
            request = self._request()
        except RequestValidationError as exc:
            messagebox.showerror(self._t("cannot_start"), str(exc))
            return
        self.cancel_event.clear()
        self._set_running(True)
        self._append(self._t("starting"))
        self.worker = threading.Thread(target=self._worker_main, args=(request,), daemon=True)
        self.worker.start()

    def _request(self) -> TranscriptionRequest:
        return build_request(self)

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
                self.status_var.set(self._t("failed"))
                self._append(str(payload))
                messagebox.showerror(self._t("transcription_failed"), str(payload))
            elif kind == "done" and isinstance(payload, TranscriptionResult):
                self._set_running(False)
                self.result_paths = {"srt": payload.srt_path, "json": payload.json_path}
                self.json_var.set(str(payload.json_path))
                if payload.html_path:
                    self.result_paths["html"] = payload.html_path
                self.status_var.set(self._t("done"))
                self._append(self._t("finished"))
        self.root.after(100, self._poll_events)

    def _cancel(self) -> None:
        self.cancel_event.set()
        self.status_var.set(self._t("cancelling"))

    def _set_running(self, running: bool) -> None:
        self.start_button.configure(state="disabled" if running else "normal")
        self.cancel_button.configure(state="normal" if running else "disabled")
        if running:
            self.progress.start(10)
            self.status_var.set(self._t("running"))
        else:
            self.progress.stop()

    def _toggle_server(self) -> None:
        if self.server_process and self.server_process.poll() is None:
            self._stop_server()
            return
        try:
            json_path = self._server_json_path()
            port = int(self.port_var.get())
        except (RequestValidationError, ValueError) as exc:
            messagebox.showerror(self._t("cannot_start"), str(exc))
            return
        start_editor_server(self, json_path, self.media_var.get(), port)

    def _server_json_path(self) -> Path:
        path = Path(self.json_var.get().strip()).expanduser()
        if not path.exists():
            raise RequestValidationError(self._t("need_json"))
        return path

    def _poll_server(self) -> None:
        poll_editor_server(self)
        self.root.after(1000, self._poll_server)

    def _stop_server(self) -> None:
        stop_editor_server(self)

    def _save_settings(self) -> None:
        save_settings(self)
        self.api_status_var.set(self._key_status(self.api_key_var.get()))
        self.status_var.set(self._t("saved"))

    def _toggle_language(self) -> None:
        self.lang = "en" if self.lang == "zh" else "zh"
        save_env(Path(__file__).resolve().parents[1] / ".env", {"MAW_GUI_LANG": self.lang})
        self._apply_language()

    def _apply_language(self) -> None:
        apply_language(self)

    def _sync_workspace_state(self) -> None:
        sync_workspace_state(value_from_label(REGIONS, self.region_var.get()), self.workspace_label, self.workspace_entry, self.workspace_hint)

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
            messagebox.showinfo(self._t("no_html_title"), self._t("no_html"))

    def _close(self) -> None:
        self.cancel_event.set()
        self._stop_server()
        self.root.destroy()

    def _key_status(self, secret: str) -> str:
        masked = masked_secret(secret)
        if masked:
            return self._t("key_loaded").format(key=masked)
        return self._t("key_empty")

    def _t(self, key: str) -> str:
        return STRINGS[self.lang][key]

def run_app() -> None:
    sv_ttk.set_theme("dark")
    GuiApp(tk.Tk()).run()
