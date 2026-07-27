# pyright: reportAny=false, reportAttributeAccessIssue=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownVariableType=false

from __future__ import annotations

from pathlib import Path
from typing import Protocol

from maw.gui_config import DEFAULT_ENV_PATH, LANGUAGES, REGIONS, model_by_label, save_env, value_from_label
from maw.gui_workflow import TranscriptionRequest


class RequestOwner(Protocol):
    media_var: object
    output_var: object
    model_var: object
    language_var: object
    api_key_var: object
    length_var: object
    region_var: object
    workspace_var: object
    lang: str

    def _t(self, key: str) -> str: ...


class RequestValidationError(ValueError):
    """Raised when required GUI input is absent or invalid."""


def build_request(owner: RequestOwner) -> TranscriptionRequest:
    media = Path(owner.media_var.get().strip()).expanduser()
    output = Path(owner.output_var.get().strip()).expanduser()
    if not media.exists():
        raise RequestValidationError(owner._t("need_media"))
    if not output.name:
        raise RequestValidationError(owner._t("need_output"))
    return TranscriptionRequest(
        media_path=media,
        srt_path=output,
        model=model_by_label(owner.model_var.get()).id,
        language=value_from_label(LANGUAGES, owner.language_var.get()),
        api_key=owner.api_key_var.get().strip(),
        length_limit=owner.length_var.get().strip(),
        region=value_from_label(REGIONS, owner.region_var.get()),
        workspace_id=owner.workspace_var.get().strip(),
    )


def save_settings(owner: RequestOwner) -> None:
    save_env(
        DEFAULT_ENV_PATH,
        {
            model_by_label(owner.model_var.get()).env_key: owner.api_key_var.get().strip(),
            "DASHSCOPE_REGION": value_from_label(REGIONS, owner.region_var.get()),
            "DASHSCOPE_DEFAULT_LANGUAGE": value_from_label(LANGUAGES, owner.language_var.get()),
            "DASHSCOPE_WORKSPACE_ID": owner.workspace_var.get().strip(),
            "MAW_GUI_LANG": owner.lang,
        },
    )
