# Arbor

A from-scratch agent harness for the terminal. Single process, library-first, no client/server daemon. Built as a TypeScript monorepo under the `@arbor-space` npm org.

> Status: M1–M6.5 complete. 313 tests passing, tsc + biome clean. Runs on **Bun** (the TUI uses OpenTUI's native terminal renderer; Node has no `node:ffi`).

## Packages

| Package | What | Runtime |
|---|---|---|
| `@arbor-space/core` | The harness library: agent loop, session tree + shadow-git rewind, extensions, todo/plan/goal/skills/templates, subagent (child-process JSONL), MCP client, background jobs, context files, usage, ask tool. UI-agnostic. | Node |
| `@arbor-space/tui` | Interactive terminal UI on `@opentui/core` (imperative renderables). | Bun |
| `@arbor-space/cli` | Thin entry point: mode dispatch (interactive / print / json / rpc), two-level slash commands. | Bun |

Headless modes (`print`, `json`, `rpc`) never load the TUI's native addon; only interactive mode lazy-imports `@arbor-space/tui`.

## Install

```bash
git clone https://github.com/crayonlu/arbor.git
cd arbor
bun install   # or npm install
```

After install the `arbor` bin is available as `npx arbor` (or `./node_modules/.bin/arbor`). Run `bun link` in `packages/cli` to put `arbor` on your PATH.

## Usage

```bash
# Interactive TUI (needs a TTY)
arbor --model anthropic/claude-opus-4-8

# One-shot: print the final reply
arbor -p --model anthropic/claude-opus-4-8 "list the .ts files"

# One-shot: stream NDJSON events
arbor --json --model anthropic/claude-opus-4-8 "refactor foo.ts"

# Embeddable stdio JSONL RPC
arbor --mode rpc --model anthropic/claude-opus-4-8

# Continue the most recent session in this cwd
arbor -c --model anthropic/claude-opus-4-8
```

Provider API keys are read from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) as in pi-ai.

### Modes

- **interactive** (default, TTY): full TUI — streaming markdown, syntax-highlighted diffs, thinking tail, pinned todo, parallel subagents with `Ctrl+T` view switching, `/` command palette, `ExtensionUi` overlays (ask/confirm/select).
- **`-p` / `--print`**: run once, print the final assistant text, exit. Piped stdin becomes the initial prompt.
- **`--json`**: stream one NDJSON event per line (the same event stream the TUI consumes).
- **`--mode rpc`**: stdio JSONL request/response protocol with an `extension_ui` roundtrip, for embedding Arbor in other apps. See [`docs/rpc-protocol.md`](docs/rpc-protocol.md).

### Slash commands (two-level)

Invoke as `/<category> <name> [args]`. Open the `/` palette in the TUI to browse.

| Category | Commands |
|---|---|
| `session` | `new`, `resume`, `fork`, `rewind <entryId>`, `tree`, `export <path>`, `name <name>` |
| `model` | `set <provider/id>`, `cycle`, `thinking <level>` |
| `context` | `compact`, `reload`, `files`, `clear` |
| `mode` | `build`, `plan` |
| `tools` | `list`, `mcp` |
| `display` | `diff`, `expand`, `theme` |
| `skill` | `skill` (insert a skill into the input — review before sending) |
| `help` | `help`, `keys`, `quit` |

`/skill` opens a picker of discovered skills; selecting one drops `/skill:<name> ` into the input (it is **not** sent). Append your task and press Enter — the invocation expands to the skill body at submit time. (This fixes pi's behavior of auto-sending on selection.)

### Keyboard (interactive)

| Key | Action |
|---|---|
| `Enter` | Send / queue as steering while running / abort on empty |
| `Esc` | Withdraw queued message / rewind a just-sent message |
| `Ctrl+C` | Abort + quit |
| `Ctrl+T` | Cycle main ↔ subagent views |
| `Ctrl+O` | Toggle expanded bash output |
| `/` | Open the command palette |

## Develop

```bash
npm run check      # tsc (core + tui + cli) + biome
npm run check:fix  # tsc + biome --write
npm test           # node:test (core + cli) + bun:test (tui)
npm run test:core  # core only
npm run test:cli   # cli only
```

- **core** uses `node:test` and runs on Node (pure library).
- **tui** uses `bun:test` with OpenTUI's headless `createTestRenderer` + `captureCharFrame` for render snapshots.
- TS strict + `erasableSyntaxOnly` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`; biome (tabs, 110 cols).

## Architecture notes

- **Rewind** is the differentiator: a session tree (fork/rewind messages) paired with shadow-git workspace snapshots, so conversation and files roll back together.
- **Subagents** run as child processes speaking a JSONL protocol; the parent surfaces an ordered thread transcript for live per-agent views. Multiple `task` calls in one turn run concurrently.
- **Extensions** are a single in-process API: `on(event)` hooks (can block/modify tool calls), `registerTool`, `registerCommand`.
- The TUI is built on `@opentui/core`'s imperative renderables (`Box`/`Text`/`Markdown`/`Diff`/`Input`/`ScrollBox`/`Select`) — no hand-rolled terminal layering, no JSX/build step.

## Design docs

- [`docs/tui-design.md`](docs/tui-design.md) — TUI layout, theme, input state machine, component map.
- [`docs/rpc-protocol.md`](docs/rpc-protocol.md) — stdio JSONL RPC protocol spec.

## Not in scope (v1)

Permission/sandbox system, client-server daemon, mouse/image/kitty-graphics, light theme, icon animations, 3-tier narrow-screen diff (split/unified only). These are deliberate v1 boundaries, not gaps.
