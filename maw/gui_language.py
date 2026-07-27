# pyright: reportAny=false, reportAttributeAccessIssue=false, reportUnknownMemberType=false, reportUnknownVariableType=false

from __future__ import annotations

import tkinter as tk
from tkinter import ttk

from maw.gui_i18n import STRINGS


def apply_language(owner: object) -> None:
    owner.root.title(owner._t("app_title"))
    for key, widget in owner.i18n_widgets.items():
        text_key = "browse" if key.endswith("_browse") else key
        widget["text"] = owner._t(text_key)
    owner.lang_button.configure(text=owner._t("other_language"))
    owner.save_key_button.configure(text=owner._t("save_key"))
    owner.server_button.configure(text=owner._t("server_stop") if owner.server_process else owner._t("server_start"))
    owner.start_button.configure(text=owner._t("start"))
    owner.cancel_button.configure(text=owner._t("cancel"))
    owner.folder_button.configure(text=owner._t("open_folder"))
    owner.html_button.configure(text=owner._t("open_html"))
    owner.length_hint.configure(text=owner._t("length_hint"))
    owner.workspace_hint.configure(text=owner._t("workspace_hint"))
    owner.api_status_var.set(owner._key_status(owner.api_key_var.get()))
    if owner.status_var.get() in {STRINGS["zh"]["ready"], STRINGS["en"]["ready"]}:
        owner.status_var.set(owner._t("ready"))


def sync_workspace_state(region: str, workspace_label: ttk.Label, workspace_entry: ttk.Entry, workspace_hint: ttk.Label) -> None:
    enabled = region == "singapore"
    widgets: tuple[tk.Widget, ...] = (workspace_label, workspace_entry, workspace_hint)
    for widget in widgets:
        if enabled:
            widget.grid()
        else:
            widget.grid_remove()
    workspace_entry.configure(state="normal" if enabled else "disabled")
