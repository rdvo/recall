---
name: recall
description: Agent memory. ALWAYS use --limit 5. NEVER use --full. Use --type on search.
---

# Recall - Agent Memory

## DO THIS (Examples)

```bash
# Quick check - what was I doing?
recall timeline --last

# Search for something specific
recall search "GLM" --cwd --type user_message --limit 5 --format json

# Vague query? Use topics first
recall topics "anthropic" --cwd --format json

# Drill into a session
recall conversation --session ses_abc --limit 20 --format json

# File history  
recall diffs --file src/api.ts --limit 5 --format json
```

## DON'T DO THIS (Anti-Patterns)

```bash
# BAD: limit 50 dumps too much context
recall timeline --limit 50

# BAD: --full dumps entire messages, bloats context
recall history --full

# BAD: no --type returns noise (code, logs, tool output)
recall search "auth" --format json

# BAD: no --limit fetches too many results
recall search "GLM" --since "1d"

# BAD: dumping everything "just in case"
recall timeline --limit 50
recall history --full  
recall search "X" --limit 100
```

## The Golden Rule

**Start with --limit 5. Check if you have enough. Only scroll if needed.**

Think like a human skimming memory, not a database dump.

## Commands

| Command | Use for | Default limit |
|---------|---------|---------------|
| `topics "X"` | **Start here for vague queries** | clusters results |
| `search "X"` | Find specific mentions | 5 |
| `timeline --last` | Quick grounding | 1 per project |
| `conversation --session` | Drill into session | 20 |
| `diffs --file` | File edit history | 5 |

## Required Flags

| Flag | Why |
|------|-----|
| `--limit 5` | Prevents context bloat |
| `--type user_message` | Filters noise on search |
| `--cwd` | Scopes to current project |
| `--format json` | Structured output |

## The Flow

```
1. SKIM: topics "X" or search "X" --limit 5
2. CHECK: Do I have enough? If yes → STOP
3. DRILL: conversation --session or --offset to scroll
```

**Signs you have enough - STOP:**
- Found a commit SHA or session ID
- Found a timestamp to reference
- Question is answered

**Don't keep adding queries "just in case"**

## Disambiguating with Topics

```bash
recall topics "anthropic" --cwd --format json
```

Returns distinct conversations:
```json
{
  "topics": [
    {"time": "2026-01-07 14:30", "preview": "thinking blocks..."},
    {"time": "2026-01-08 23:15", "preview": "tool naming..."}
  ],
  "hint": "Found 2 conversations. Ask user which one."
}
```

**Use topics when:**
- User says "remember when..." (vague)
- Query might match multiple issues

## Pagination

JSON includes `next_command`. Only use it if you actually need more:

```json
{"pagination": {"next_command": "recall search ... --offset 5"}}
```

**Before scrolling: Do I already have what I need?**

## Project Filtering

```bash
--cwd                      # Auto-detect from working directory
--project opencode         # By name/partial match
```

## JSON Access

| Command | Access with |
|---------|-------------|
| `search` | `.results[]` |
| `topics` | `.topics[]` |
| `conversation` | `.events[]` |
| `timeline` | `.events[]` |
