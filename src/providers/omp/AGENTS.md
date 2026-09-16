# OMP Provider

`src/providers/omp/` adapts omp through an `omp --mode rpc-ui` subprocess.

## Dependency Boundary

- omp RPC payloads, extension UI, session files, model metadata, commands, and provider state remain provider-owned until normalized into core contracts.
- The NDJSON transport is shared: use `@/core/rpc/JsonlRpcTransport` (plus `JsonlRpcRecord`, `JsonlRpcTransportClosedError`, `JsonlRpcResponseError`). Never import transport code from another provider.

## Ownership

| Component or area | Owns |
| --- | --- |
| `OmpExecutionSession` | Provider execution binding, request/event lifecycle, provider snapshots, cancellation, and recovery |
| `OmpRpcSessionKernel` behind `OmpExecutionKernel` | RPC turn coordination and live omp execution mechanics |
| `OmpLaunchSpec` and `OmpSubprocess` | Command-line, environment, subprocess, and transport construction |
| `OmpExtensionUiBridge` | Typed routing of provider extension UI requests to the Obsidian renderer |
| `history/` | Native JSONL discovery, read-only replay and historical model recovery, and new fork-file materialization |
| `OmpModelDiscoveryService` and `OmpCommandMetadataProbe` | Independent metadata subprocesses and their results |

## Protocol Rules

- Launch arguments are built in `OmpLaunchSpec.ts`. Keep command-line shape there instead of scattering flags across runtime code.
- Our mode is `--mode rpc-ui`, not `--mode rpc`. Only `rpc-ui` sets `hasUI = true`, which makes tool approvals and dialogs arrive as `extension_ui_request` frames instead of failing closed; it also implies `PI_NO_PTY=1`.
- On Windows, treat a bun-global `omp.cmd`, `omp.ps1`, `omp.bunx`, or 8 KB bun shim as an installation locator only: resolve `@oh-my-pi/pi-coding-agent/dist/cli.js` from it and launch that entry through `bun` with structured arguments (fall back to a shipped single-file `omp-windows-x64.exe`). Never serialize omp prompts, session targets, or any other argument through `cmd.exe` or `shell: true`; fail closed when neither bun nor a direct binary can be established.
- A ready frame carries `protocolVersion: 1`; validate it before sending any command and stay on protocol v1.
- Live events are normalized through `normalizeOmpRpcEvent()` and `OmpEventNormalizationState`. omp frames are a superset of pi's (`auto_compaction_*`, `auto_retry_*`, `model_changed`, `thinking_level_changed`, `notice`); unknown frames are ignored, never fatal.
- Every `extension_ui_request` must be answered with a matching `extension_ui_response`, including unknown methods (answer with cancellation). An unanswered request hangs the agent.
- Compact turns call the `compact` RPC request and emit a `context_compacted` stream chunk.

## Session and History Rules

- `OmpProviderState` may store `sessionId`, `sessionFile`, `leafEntryId`, `parentSession`, `previousSessions`, and fork metadata. Do not infer these fields in feature code.
- omp can resume by session ID or absolute session file. Absolute session files can be switched in a live process; other target changes require process restart.
- A relaunched kernel must prove that its initial `get_state` identity matches the requested resume file or ID before any prompt, steer request, or extension dialog response can carry user input. A mismatch fails the turn without replacing persisted session state.
- History hydration reads omp JSONL sessions from vault-local (`.omp/agent/sessions/`) and user-level (`~/.omp/agent/sessions/`) roots; legacy `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` still select the agent and session directories. Two omp relocations are deliberately not searched (same boundary as the pi provider): named `OMP_PROFILE`/`PI_PROFILE` roots (`~/.omp/profiles/<name>/agent/sessions`) and the `$XDG_DATA_HOME/omp/sessions` layout. Live sessions still bind through the provider's own reported session file.
- A native session file starts with a fixed-width 256-UTF-8-byte `title` slot (`{ type: 'title', v: 1, ... }`) followed by the `session` header (`CURRENT_SESSION_VERSION = 3`, and `version` may be absent). Legacy files begin directly with the header and must still parse. These files are read-only; never rewrite the title slot or truncate entries.
- Forking creates a new omp session file by copying the source branch up to `resumeAt` without altering or truncating the source. Keep fork materialization provider-owned.
- Historical selected-model recovery walks the active JSONL branch to `leafEntryId` and preserves the last native provider/model pair. A missing persisted leaf must fail closed instead of using another branch; never promote `previousSessions` or a recovery-only locator into the live binding.
- Environment keys that affect omp data or package locations invalidate existing omp sessions.
- The runtime fingerprint includes `OMP_PROFILE`, `PI_PROFILE`, `PI_CONFIG_FILES`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `OMP_WORKTREE_DIR`, `OMP_AUTH_BROKER_URL`, `OMP_AUTH_BROKER_TOKEN`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, `PI_CACHE_RETENTION`, `PATH`, and explicit/host CLI-path inputs.

## Commands and Models

- Runtime commands use the `get_available_commands` RPC; omp does not implement pi's legacy command-discovery RPC. Keep the pushed `available_commands_update` catalog as fallback and expose the normalized result through `OmpCommandCatalog`.
- Model discovery uses a separate subprocess and may receive extension UI requests. Keep model normalization in `models.ts`. omp entries carry `thinking: { mode: 'effort', efforts: [...] }`, an `input` array, and an extra `cost.timeBased`; unknown keys are ignored rather than rejected.
- `models.ts` is the single owner of the thinking union `off | minimal | low | medium | high | xhigh | max | auto`, matching omp's `--thinking` vocabulary; runtime, settings, and UI import it instead of re-declaring levels.
- Use model-provided context windows when available; otherwise preserve the existing fallback behavior.

## Gotchas

- Images are passed as prompt image blocks only when attachment data is available.
- `new_session` invalidates persisted session state until the provider reports a replacement session.
- Tool mode can launch omp with readonly tools (`read,grep,glob`; omp has no `ls`, and `find` is only a legacy alias of `glob`) or no tools. Keep that logic in launch-spec construction.
- omp still honors legacy `PI_*` environment keys, so `registration.ts` claims both `/^OMP_/i` and `/^PI_/i`. omp must stay registered after pi, or `PI_*` environment classification moves to omp.
