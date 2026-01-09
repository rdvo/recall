#!/bin/bash
# Session - Summarize a session
# Usage: ./session.sh [session_id] [--json]
#
# Examples:
#   ./session.sh                    # Most recent session
#   ./session.sh ses_abc123         # Specific session
#   ./session.sh ses_abc123 --json

set -e

SESSION_ID=""
JSON_MODE=false

# Parse arguments
for arg in "$@"; do
    case $arg in
        --json|-j)
            JSON_MODE=true
            ;;
        -h|--help)
            echo "Usage: ./session.sh [session_id] [--json]"
            echo ""
            echo "Summarize a session - conversation, files touched, edits made."
            echo ""
            echo "Arguments:"
            echo "  [session_id]   Session ID (default: most recent)"
            echo "  --json, -j     Output JSON format"
            echo ""
            echo "Examples:"
            echo "  ./session.sh                    # Most recent session"
            echo "  ./session.sh ses_abc123         # Specific session"
            exit 0
            ;;
        ses_*)
            SESSION_ID="$arg"
            ;;
    esac
done

# Find recall command
if command -v recall &> /dev/null; then
    RECALL="recall"
elif [ -f "$HOME/.local/bin/recall" ]; then
    RECALL="$HOME/.local/bin/recall"
else
    RECALL="npx recall"
fi

# If no session ID, get most recent
if [ -z "$SESSION_ID" ]; then
    # Try to extract from timeline --last
    SESSION_ID=$($RECALL timeline --last --limit 1 --format json 2>/dev/null | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
    
    if [ -z "$SESSION_ID" ]; then
        echo "No recent session found."
        echo "Usage: ./session.sh [session_id]"
        echo "Run ./ground.sh to see available sessions."
        exit 0
    fi
fi

if [ "$JSON_MODE" = true ]; then
    echo "{"
    echo "  \"session_id\": \"$SESSION_ID\","
    echo "  \"conversation\": "
    $RECALL conversation --session "$SESSION_ID" --limit 30 --format json 2>/dev/null || echo "{\"events\":[]}"
    echo ","
    echo "  \"files\": "
    $RECALL files --session "$SESSION_ID" --format json 2>/dev/null || echo "{\"results\":[]}"
    echo ","
    echo "  \"diffs\": "
    $RECALL diffs --session "$SESSION_ID" --limit 15 --format json 2>/dev/null || echo "[]"
    echo "}"
else
    echo "=== Session: $SESSION_ID ==="
    echo ""
    
    echo "--- Conversation (last 20 messages) ---"
    $RECALL conversation --session "$SESSION_ID" --limit 20 2>/dev/null || echo "No messages found"
    echo ""
    
    echo "--- Files Touched ---"
    $RECALL files --session "$SESSION_ID" --limit 15 2>/dev/null || echo "No files found"
    echo ""
    
    echo "--- Edits Made ---"
    $RECALL diffs --session "$SESSION_ID" --limit 10 2>/dev/null || echo "No edits found"
    echo ""
    
    echo "Tip: Use ./around.sh <timestamp> to see context around a specific moment."
fi
