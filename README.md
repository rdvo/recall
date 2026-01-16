# Total Recall

![Total Recall](https://reactormag.com/wp-content/uploads/2025/11/total-recall-arnold-740x423.jpeg)

**Universal Memory Layer for AI Agents**

Recall auto-ingests conversations, tool calls, and git commits from Claude Code, OpenCode, and other AI agents into a searchable SQLite database. Agents can recall context without re-explaining.

## Install

```bash
npm install && npm run build && npm link

# Add sources (auto-discovers sessions and repos)
recall sources add claude-code
recall sources add opencode

# Start watching for new events
recall watch on
```

## Usage

```bash
# Search conversations (always use --type!)
recall search "auth bug" --cwd --type user_message --format json

# Search multiple terms (grep-style OR works)
recall search "warez|keygen|cracked" --cwd --type user_message --format json

# Recent activity
recall timeline --last

# File edit history
recall diffs --file src/api.ts --format json

# Session transcript
recall conversation --session ses_abc --format json
```

## Key Flags

| Flag | What it does |
|------|--------------|
| `--cwd` | Filter by current project (auto-detects from working directory) |
| `--type user_message` | Only user messages (not code/tool noise) |
| `--project X` | Filter by project (ID, display name, path, or partial match) |
| `--format json` | JSON output with pagination |

## Commands

| Command | Purpose |
|---------|---------|
| `search "X"` | Full-text search across all events |
| `timeline` | Chronological view (default: last 2h) |
| `timeline --last` | Quick status: last activity per project |
| `conversation --session <id>` | Full session transcript |
| `diffs --file <path>` | File edit history |
| `files` | Files accessed by agents |

## Agent Integration

For agents using recall, see the skill file at `.opencode/skill/recall/SKILL.md` which documents:
- The `--cwd` and `--type` patterns
- JSON schemas for each command
- Parallel vs chained queries
- Wide net → drill → scroll pattern

## How It Works

1. **Ingestion**: Watches Claude Code (`~/.claude/`), OpenCode (`~/.local/share/opencode/`), and git repos
2. **Parsing**: Extracts messages, tool calls, file content
3. **Storage**: SQLite with FTS5 full-text search (~1ms queries)
4. **Redaction**: Auto-removes secrets before storage

### What Gets Stored

| Source | Event Types |
|--------|-------------|
| Claude Code / OpenCode | `user_message`, `assistant_message`, `tool_call`, `tool_result` |
| Git | `git_commit` |

Tool results include **full file content** so agents can recall what files looked like.

## Data Location

- **Database**: `~/.local/share/recall/recall.sqlite`
- **Claude Code**: `~/.claude/projects/<project>/<session>.jsonl`
- **OpenCode**: `~/.local/share/opencode/storage/<session>.jsonl`

## Uninstall

```bash
./uninstall.sh  # Removes command, database, and all data
```

## License

MIT
