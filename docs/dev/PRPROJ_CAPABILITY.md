# PRPROJ capability gate

- [x] Expose `GET /api/prproj-capability` as a machine-readable capability check.
- [x] Expose `POST /api/prproj` as an explicit unsupported result.
- [x] Keep both routes server-only and loopback-scoped; no editor UI integration.
- [x] Do not emit gzip/XML/PRPROJ bytes, read arbitrary paths, or claim compatibility.

## Result

The local server does not currently have a pinned independently licensed `.prproj`
writer and profile. Therefore generation is deliberately unavailable.

`GET /api/prproj-capability` returns HTTP `200`:

```json
{"ok":false,"capability":"prproj","supported":false,"reason":"no_pinned_writer_or_profile","profile":null,"route":"/api/prproj"}
```

`POST /api/prproj` returns the same JSON payload with HTTP `501 Not Implemented`.
The route does not parse a body or inspect an output path, and it never writes a
file. Neither route claims Premiere or `.prproj` compatibility.

Evidence: `tests.test_local_editor_server.LocalEditorServerTests.test_prproj_capability_endpoint_is_stable_and_loopback_only`
and `tests.test_local_editor_server.LocalEditorServerTests.test_prproj_generation_route_refuses_without_writing`.
