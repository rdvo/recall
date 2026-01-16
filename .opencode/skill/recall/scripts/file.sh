#!/bin/bash
# File - Everything about a file: edits, reads, mentions
# Usage: ./file.sh <file_path> [--since <time>] [--json]
#
# Examples:
#   ./file.sh src/api.ts
#   ./file.sh src/llm.ts --since "1d"
#   ./file.sh src/api.ts --json

set -e

FILE_PATH=""
SINCE="1w"
JSON_MODE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --json|-j)
            JSON_MODE=true
            shift
            ;;
        --since|-s)
            SINCE="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: ./file.sh <file_path> [--since <time>] [--json]"
            echo ""
            echo "Show everything about a file: edits, reads, mentions."
            echo ""
            echo "Arguments:"
            echo "  <file_path>    Path to the file (can be partial)"
            echo "  --since, -s    Time range (default: 1w). Examples: 1d, 1w, 1mo"
            echo "  --json, -j     Output JSON format"
            echo ""
            echo "Examples:"
            echo "  ./file.sh src/api.ts"
            echo "  ./file.sh llm.ts --since '1d'"
            exit 0
            ;;
        *)
            if [ -z "$FILE_PATH" ]; then
                FILE_PATH="$1"
            fi
            shift
            ;;
    esac
done

if [ -z "$FILE_PATH" ]; then
    echo "Error: file path required"
    echo "Usage: ./file.sh <file_path> [--since <time>] [--json]"
    echo "Example: ./file.sh src/api.ts"
    exit 0
fi

# Find recall command
if command -v recall &> /dev/null; then
    RECALL="recall"
elif [ -f "$HOME/.local/bin/recall" ]; then
    RECALL="$HOME/.local/bin/recall"
else
    RECALL="npx recall"
fi

# Extract filename for searching
FILENAME=$(basename "$FILE_PATH")

if [ "$JSON_MODE" = true ]; then
    echo "{"
    echo "  \"file_path\": \"$FILE_PATH\","
    echo "  \"filename\": \"$FILENAME\","
    echo "  \"since\": \"$SINCE\","
    echo "  \"diffs\": "
    $RECALL diffs --file "$FILE_PATH" --since "$SINCE" --limit 15 --format json 2>/dev/null || echo "[]"
    echo ","
    echo "  \"user_mentions\": "
    $RECALL search "$FILENAME" --type user_message --since "$SINCE" --limit 10 --format json 2>/dev/null || echo "{\"results\":[]}"
    echo ","
    echo "  \"tool_calls\": "
    $RECALL search "$FILE_PATH" --type tool_call --since "$SINCE" --limit 15 --format json 2>/dev/null || echo "{\"results\":[]}"
    echo "}"
else
    echo "=== File: $FILE_PATH (since $SINCE) ==="
    echo ""
    
    echo "--- Edits (diffs) ---"
    $RECALL diffs --file "$FILE_PATH" --since "$SINCE" --limit 10 2>/dev/null || echo "No edits found"
    echo ""
    
    echo "--- Your Mentions ---"
    $RECALL search "$FILENAME" --type user_message --since "$SINCE" --limit 8 2>/dev/null || echo "No mentions found"
    echo ""
    
    echo "--- Tool Calls (reads/writes) ---"
    $RECALL search "$FILE_PATH" --type tool_call --since "$SINCE" --limit 10 2>/dev/null || echo "No tool calls found"
    echo ""
    
    echo "--- File History ---"
    $RECALL file-history "$FILE_PATH" --limit 5 2>/dev/null || echo "No history found"
    echo ""
    
    echo "Tip: Use 'recall diffs --file $FILE_PATH' to see edit history."
fi
