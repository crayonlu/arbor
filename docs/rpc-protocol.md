# Arbor RPC Protocol

`arbor --mode rpc` speaks a line-delimited JSON (JSONL) protocol over stdio for
embedding Arbor in other applications (editors, GUIs, test harnesses, other
agents). One JSON object per line, terminated by `\n`. Frames are split on LF
only — U+2028/U+2029 inside strings are escaped so they cannot break framing.

## Transport

- **stdin**: commands and `extension_ui_response` replies (host → Arbor).
- **stdout**: `response` records, `AgentEvent` streams, and
  `extension_ui_request` records (Arbor → host).
- **stderr**: human-readable diagnostics (never protocol).

stdout is owned by the protocol while Arbor runs; anything else written to
stdout is diverted to stderr so it cannot corrupt the stream.

## Records

### Command (stdin)

```jsonc
{ "type": "<command>", "id": "<optional correlation id>", ... }
```

`id` is optional; when present, the matching `response` carries the same `id`.

### Response (stdout)

```jsonc
{ "type": "response", "id": "<echoed>", "command": "<command>", "success": true, "data": {...} }
{ "type": "response", "id": "<echoed>", "command": "<command>", "success": false, "error": "..." }
```

### Events (stdout)

AgentEvents stream as they occur (no `id`). Each has a discriminating `type`
field, e.g. `agent_start`, `message_update`, `tool_execution_start`,
`tool_execution_end`, `usage_update`, `job_notification`, `agent_end`, …
(see `@arbor-space/core` `AgentEvent`).

### Extension UI roundtrip (stdout → stdin)

When the agent needs human input (the ask tool, a confirmation, a selector),
Arbor emits a request and waits for the host's reply:

```jsonc
// stdout
{ "type": "extension_ui_request", "id": "<uuid>", "method": "confirm", "title": "...", "message": "..." }
// stdin (host replies with the same id)
{ "type": "extension_ui_response", "id": "<uuid>", "confirmed": true }
```

`method` ∈ `notify` (fire-and-forget, no reply), `confirm`, `input`, `select`,
`ask`. Requests time out after 120s if unanswered.

## Commands

| type             | fields                              | notes                                              |
| ---------------- | ----------------------------------- | -------------------------------------------------- |
| `prompt`         | `message`, `images?`                | Streams events; responds immediately.              |
| `steer`          | `message`                           | Inject a message between turns.                    |
| `abort`          | —                                   | Abort the running turn.                            |
| `request_stop`   | —                                   | Stop after the current turn.                       |
| `get_state`      | —                                   | model, mode, isRunning, counts, usage.             |
| `get_messages`   | —                                   | Full message list.                                 |
| `set_model`      | `provider`, `modelId`               | Switch model.                                      |
| `set_mode`       | `mode`: `build` \| `plan`           | Switch mode.                                       |
| `compact`        | —                                   | Manually compact.                                  |
| `rewind`         | `entryId`                           | Rewind conversation + workspace.                   |
| `get_tree`       | —                                   | Session entry tree + leaf id.                      |
| `get_entries`    | `since?`                            | Entries, optionally after `since`.                 |
| `get_commands`   | —                                   | Available slash commands (categorized).            |
| `invoke_command` | `text`                              | Run a `/<category> <name>` slash command headlessly.|
| `set_session_name` | `name`                            | Rename the session.                                |
| `shutdown`       | —                                   | Clean teardown, then exit.                         |

## Example session

```jsonc
// host → arbor
{"type":"prompt","id":"1","message":"list the .ts files"}
// arbor → host: immediate ack
{"type":"response","id":"1","command":"prompt","success":true}
// arbor → host: streamed events
{"type":"agent_start"}
{"type":"message_start","message":{...}}
{"type":"tool_execution_start","toolCallId":"...","toolName":"bash","args":{...}}
{"type":"tool_execution_end","toolCallId":"...","...":"..."}
{"type":"agent_end","messages":[...]}
{"type":"usage_update","totals":{...}}

// agent asks the user a question
{"type":"extension_ui_request","id":"<uuid>","method":"ask","question":{"question":"Which?","options":[{"label":"A"},{"label":"B"}]}}
// host replies
{"type":"extension_ui_response","id":"<uuid>","value":["A"]}

// graceful exit
{"type":"shutdown","id":"2"}
{"type":"response","id":"2","command":"shutdown","success":true}
```

stdin `end` (EOF) also triggers a clean shutdown. `SIGTERM`/`SIGHUP` tear down
and exit with 143/129 respectively.
