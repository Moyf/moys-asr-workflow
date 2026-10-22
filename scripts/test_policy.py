"""Small, conservative test ownership map. New tests default to the common gate."""
from __future__ import annotations

import os

PYTHON_PACKS = ("common", "media", "long-media", "tools", "manual")
WINDOWS_FFMPEG_TESTS = (
    "tests.test_ffmpeg.FfmpegResolverTests.test_windows_python_module_does_not_shadow_path_executables",
    "tests.test_ffmpeg.FfmpegResolverTests.test_windows_scripts_are_not_accepted_as_ffmpeg_executables",
)
MEDIA_MODULES = {"test_ffprobe_failure_integration", "test_gap_removed_audio_export", "test_gap_removed_video_compatibility",
                 "test_media_cache", "test_quapeaks_generation",
                 "test_thumbnail_jobs_integration", "test_thumbnail_server"}
MEDIA_CLASSES = {
    ("test_audio_loudness", "RealLoudnessTests"),
    ("test_burn_video_export", "BurnVideoPrecisionTests"),
    ("test_media_keyframes", "RealKeyframeInspectorTests"),
    ("test_gap_removed_embedded_subtitles", "EmbeddedSubtitleTimelineTests"),
    ("test_gap_removed_video_timeline", "RealVideoTimelineTests"),
}
TOOL_MODULES = {"test_docs_check", "test_release_notes", "test_release_site", "test_release_publication", "test_run_check", "test_run_tests_runner",
                "test_verification_checklist", "test_verification_checklist_build", "test_verify_sha256_script", "test_macos_icon",
                "test_packaging_contract", "test_test_workflow", "test_browser_results"}
MEDIA_METHODS = {
    "test_streaming_extraction_and_cache_match", "test_low_rate_multichannel_keeps_opposite_and_one_sided_audio",
    "test_mono_stays_identical_and_third_channel_is_included", "test_mopeaks_generation_does_not_need_native_quapeaks",
    "test_embed_waveform_adds_valid_payload_without_writing_cache",
    "test_real_audio_pipeline_writes_loadable_artifacts_without_asr",
    "test_low_volume_and_nfd_input_align_without_silence_gate",
    "test_real_preflight_never_loads_model_or_writes_artifacts",
    "test_ass_frame_render_uses_real_libass_when_available",
    "test_green_screen_frame_uses_playhead_time_with_real_libass",
    "test_srt_filter_with_special_font_name_parses_in_real_ffmpeg",
    "test_real_ffmpeg_cancel_removes_output_without_changing_source",
    "test_real_stream_copy_mp4_mkv_ts_multitrack_and_nonzero_origin",
    "test_final_generation_uses_selected_audio_track",
    "test_full_pipeline_preserves_extra_gap_and_original_text",
    "test_internal_repetition_joins_only_kept_audio_and_rejects_cross_join_tokens",
    "test_long_source_offsets_nfd_and_later_line_failure_are_transactional",
    "test_retained_extra_inside_joined_script_envelope_refuses_finalization",
    "test_source_items_fill_keeps_asr_text_and_publishes_only_complete_output",
    "test_source_items_fill_uses_selected_audio_track_and_original_offsets",
}

def python_pack(test_id: str) -> str:
    parts = test_id.split(".")
    module = next((part for part in parts if part.startswith("test_")), "")
    method = parts[-1]
    if module in TOOL_MODULES:
        return "tools"
    if method == "test_real_mosp_keeps_only_real_take_boundaries":
        return "manual"
    if "LongMediaGeneratedFixtureTests" in parts or method == "test_eleven_minute_real_audio_preserves_acoustic_offsets":
        return "long-media"
    if any(owner == module and name in parts for owner, name in MEDIA_CLASSES):
        return "media"
    if module == "test_thumbnails" and "ThumbnailIntegrationTests" in parts:
        return "media"
    if module in MEDIA_MODULES or (module == "test_reapeaks_fixture" and "GeneratedFixtureTests" in parts):
        return "media"
    if method in MEDIA_METHODS or (module == "test_reapeaks" and method.startswith("test_generate_for_media_")):
        return "media"
    return "common"


def allowed_platform_skip(test_id: str, reason: str) -> bool:
    """Only exact platform guards are exempt; missing capabilities still fail."""
    identity = test_id.removeprefix("tests.")
    if os.name == "nt":
        return (identity == "test_gui_web.GuiWebBridgeTests.test_open_existing_path_uses_external_opener_for_file_and_folder"
                and reason == "Non-Windows paths use the external opener")
    return (identity in {name.removeprefix("tests.") for name in WINDOWS_FFMPEG_TESTS} and reason == "Windows PATHEXT resolution"
            or identity == "test_gui_web.GuiWebBridgeTests.test_open_output_folder_uses_startfile_on_windows"
            and reason == "os.startfile 仅 Windows 可用；os.name 补丁会让 pathlib 选择 WindowsPath"
            or identity == "test_local_log.DefaultLogDirectoryTests.test_uses_localappdata_namespace"
            and reason == "LOCALAPPDATA 变量仅为 Windows 语义")
