---
name: recall
description: Memory layer for AI agents. Query past conversations, file edits, and tool calls. START with 'recall timeline --last' to ground yourself.
---

# Recall - Agent Memory

## ALWAYS START HERE

```bash
# Ground yourself FIRST - get current time and context
recall timeline --last
```

This shows you:
- Current date/time (use this for --since/--until queries)
- Last message, commit, tool call
- Which project you're in

**Never skip this.** You need the real date/time, not assumed dates.



## Quick Start

```bash
# Search conversations
recall search "auth bug" --type user_message --limit 5 --format json

# See file edit history (MUST use Z suffix on timestamps!)
recall diffs --file api.ts --since "2026-01-11T00:00:00Z" --limit 10 --format json

# Reconstruct a corrupted file from edit history
recall diffs --file corrupted.tsx --session ses_abc --until "2026-01-11T01:00:00Z" --limit 1000 --format json
```

## Core Commands

| Command | Use | Time Range |
|---------|-----|------------|
| `timeline --last` | Quick status check | auto |
| `search "X"` | Find mentions | all time |
| `reconstruct path.tsx --at "TIME"` | **Rebuild corrupted file** | up to TIME |
| `diffs --file path.tsx --limit 1000` | File edit history | 24h (or --until) |
| `conversation --session ses_xxx` | View session messages | all time |

**Note:** Use `reconstruct` to rebuild corrupted files - it applies all edits sequentially.

## Reconstructing Files

**DO NOT read the recovered file!** Just write it directly:

```bash
# STEP 1: Ground yourself
recall timeline --last

# STEP 2: Reconstruct directly to destination (NO READING!)
recall reconstruct prompt-input.tsx \
  --at "2026-01-11T01:00:00" \
  --output /path/to/target/file.tsx

# Done! File is recovered. DO NOT cat/head/Read it.
```

**How it works:**
1. Tries to find a Read tool result (instant snapshot)
2. Falls back to Edit reconstruction if needed
3. Writes complete file to `--output`

**CRITICAL RULES:**
- **NEVER Read/cat the recovered file** - it clogs your context
- **Write directly to destination** with `--output`
- **Just report: "File recovered to X"** - don't verify by reading
- Use `--at` for time BEFORE corruption
- Get correct year from `timeline --last` first

**Example:**
```bash
recall reconstruct prompt-input.tsx \
  --at "2026-01-11T01:00:00" \
  --output /Users/rob/dev/project/src/components/prompt-input.tsx
# Done! Don't read it.
```

## Best Practices

**DO:**
- Start with `--limit 5`, only increase if needed
- Use `--type user_message` when searching to filter noise
- Use `--session` to drill into specific sessions (auto-searches all time)
- Use `--cwd` or `--project` to scope to current project
- Use `--format json` for structured output

**DON'T:**
- Use `--limit 50+` unless reconstructing files
- Use `--full` (bloats context)
- Search without `--type` (returns tool output noise)

## Time Filtering

```bash
--since "2026-01-10T21:00:00"     # ISO timestamp (Z auto-added)
--since "2h"                       # Relative time  
--until "2026-01-11T01:00:00"     # Stop before this time

# WRONG - will return no results:
--since "2025-01-10T21:00:00"     # ✗ Wrong year! Use timeline --last to get real date
```

**Important:** Run `timeline --last` first to get the correct year - don't assume 2025 or 2026!

When `--session` is specified, defaults to all time (you want that specific session).

## Project Scoping

```bash
--cwd              # Auto-detect from current directory
--project recall   # Filter by project name
```

## JSON Output

All commands support `--format json` with pagination:

```json
{
  "events": [...],
  "pagination": {
    "offset": 0,
    "limit": 5,
    "total": 42,
    "has_more": true,
    "next_command": "recall diffs --file api.ts --offset 5"
  }
}
```
