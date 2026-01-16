# Recall (Total Recall)

**Universal Memory Layer for AI Agents**

Recall ingests agent conversations and tool activity into a local SQLite database, then provides a CLI for fast, structured retrieval (search, timelines, file history, and recovery).

It is designed to let agents (and humans) answer: “what just happened?”, “where was that mentioned?”, and “what did this file look like before it broke?”

## Install

Prereqs: Node.js (ESM). If you’re developing locally:

```bash
npm install
npm run build
npm link
```

This exposes:

- `recall` (v2, current)
- `recall-v1` (legacy CLI)

## Quick Start

1) Register sources (auto-discovers sessions/projects):

```bash
recall sources add claude-code
recall sources add opencode
recall sources add cursor

# Optional: track a repo directly
recall sources add git
# or
recall sources add git --dir ~/projects/myapp
```

2) Ingest once:

```bash
recall ingest
```

3) Or keep it live with the watcher:

```bash
recall watch on
recall watch status
```

To stop:

```bash
recall watch off
```

## Core Usage

### Grounding / “where did we leave off?”

```bash
recall timeline --last
# or per project
recall timeline --last --project "*recall*"
```

### Search

Search is full-text and supports filters (project/session/type/tool/role/time) and multiple output formats.

```bash
# Always filter by type to avoid tool-noise
recall search "auth bug" --type user_message --cwd --limit 10

# OR query (grep-style)
recall search "warez|keygen|cracked" --type user_message --cwd

# Tool-only search (wildcards supported)
recall search "timeout" --type tool_result --tool Bash --since "3d"

# JSON output (good for agents)
recall search "vector" --type assistant_message --format json
```

### Conversations / history

```bash
# Interleaved messages (optionally include tools)
recall conversation --since "2h" --with-tools

# Full session transcript
recall conversation --session "ses_*" --full

# Your user messages across time
recall history --since "7d" --limit 50
```

### File history

Recall stores file content as seen by agents (via tool results), and stores edit diffs from Edit tool calls.

```bash
# View file content from the database
recall file src/v2/cli.ts
recall file src/v2/cli.ts:50-120
recall file src/v2/cli.ts --at "2h ago"

# Show Edit diffs (oldString -> newString)
recall diffs --file src/v2/cli.ts --since "1d"

# Versions over time
recall file-history src/v2/cli.ts --since "3d"
```

### More commands

```bash
# Project overview
recall projects list
recall projects status

# Find a relevant session quickly
recall session "that auth bug" --format json

# Watch recent errors (tests/build/lint in tool output)
recall errors --since "3d"

# Symbol indexing / lookup (fast navigation)
recall symbols --search "handle*"

# Foreground watcher (debug)
recall serve
```

## Recover / Rebuild Corrupted Files (`reconstruct`)

If an agent corrupted a file (bad Edit, truncation, etc), `reconstruct` can rebuild a best-effort version as-of a specific time.

```bash
# Write recovered content directly to a destination file
recall reconstruct src/components/prompt-input.tsx \
  --at "2026-01-11T01:00:00" \
  --output /Users/you/dev/app/src/components/prompt-input.tsx
```

How it works:

1. Tries to find a `Read` tool result for that file before `--at` (fast “snapshot”).
2. If no Read exists, it replays `Edit` history by applying `oldString -> newString` sequentially (best-effort).

Notes:

- `--at` accepts ISO timestamps, shorthand (`2h`, `3d`), and human (`"3 hours ago"`).
- Replaying edits can be imperfect if an `oldString` no longer matches; the command reports applied vs failed edits.

## Sources

Supported source types:

- `claude-code`: Claude Code project/session JSONL under `~/.claude/projects/`
- `opencode`: OpenCode storage under `~/.local/share/opencode/storage/` (includes sessions, message parts, diffs, and OpenCode snapshots)
- `cursor`: Cursor agent transcripts under `~/.cursor/projects/` (agent mode)
- `git`: git commit history for a repo

## Data Locations

- Database: `~/.local/share/recall/recall.sqlite`
- Watcher PID/log:
  - `~/.local/share/recall/watch.pid`
  - `~/.local/share/recall/watch.log`

## Formats and Pagination

Most listing commands support:

- `--format table` (default)
- `--format json` / `jsonl` / `csv` (varies by command)
- `--limit N` + `--offset N`

JSON responses include pagination metadata and a `next_command` when more results exist.

## Development

```bash
# Run CLI without building
npm run recall -- timeline --last

# Watch mode for CLI development
npm run dev

# Typecheck
npm run typecheck
```

## Uninstall

```bash
./uninstall.sh
```

This removes the CLI and deletes Recall’s stored database/data.
