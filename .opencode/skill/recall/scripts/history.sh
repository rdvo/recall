#!/bin/bash
# History - Find when something was mentioned ("When did I...")
# Usage: ./history.sh <query> [--since <time>] [--json]
#
# Examples:
#   ./history.sh "deploy"
#   ./history.sh "doctor" --since "1w"
#   ./history.sh "auth bug" --json

set -e

QUERY=""
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
            echo "Usage: ./history.sh <query> [--since <time>] [--json]"
            echo ""
            echo "Find when something was mentioned. Great for 'when did I...' questions."
            echo ""
            echo "Arguments:"
            echo "  <query>        What to search for"
            echo "  --since, -s    Time range (default: 1w). Examples: 1d, 1w, 1mo"
            echo "  --json, -j     Output JSON format"
            echo ""
            echo "Examples:"
            echo "  ./history.sh 'deploy'"
            echo "  ./history.sh 'doctor' --since '1mo'"
            exit 0
            ;;
        *)
            if [ -z "$QUERY" ]; then
                QUERY="$1"
            fi
            shift
            ;;
    esac
done

if [ -z "$QUERY" ]; then
    echo "Error: query required"
    echo "Usage: ./history.sh <query> [--since <time>] [--json]"
    echo "Example: ./history.sh 'deploy'"
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

if [ "$JSON_MODE" = true ]; then
    echo "{"
    echo "  \"query\": \"$QUERY\","
    echo "  \"since\": \"$SINCE\","
    echo "  \"user_mentions\": "
    $RECALL search "$QUERY" --type user_message --since "$SINCE" --limit 20 --format json
    echo ","
    echo "  \"assistant_mentions\": "
    $RECALL search "$QUERY" --type assistant_message --since "$SINCE" --limit 10 --format json
    echo "}"
else
    echo "=== History: \"$QUERY\" (since $SINCE) ==="
    echo ""
    
    echo "--- When YOU mentioned it ---"
    $RECALL search "$QUERY" --type user_message --since "$SINCE" --limit 15 2>/dev/null || echo "No mentions found"
    echo ""
    
    echo "--- When AGENT mentioned it ---"
    $RECALL search "$QUERY" --type assistant_message --since "$SINCE" --limit 10 2>/dev/null || echo "No mentions found"
    echo ""
    
    echo "Tip: Look at event_ts to see when. Use ./session.sh <session_id> for details."
fi
