#!/bin/bash
# Topic - Find conversations about a specific topic
# Usage: ./topic.sh <query> [--since <time>] [--json]
#
# Examples:
#   ./topic.sh "tool mapping"
#   ./topic.sh "auth bug" --since "3d"
#   ./topic.sh "anthropic" --json

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
            echo "Usage: ./topic.sh <query> [--since <time>] [--json]"
            echo ""
            echo "Find conversations about a topic. Shows which sessions discussed it."
            echo ""
            echo "Arguments:"
            echo "  <query>        What to search for"
            echo "  --since, -s    Time range (default: 1w). Examples: 1d, 1w, 1mo"
            echo "  --json, -j     Output JSON format"
            echo ""
            echo "Examples:"
            echo "  ./topic.sh 'tool mapping'"
            echo "  ./topic.sh 'auth bug' --since '3d'"
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
    echo "Usage: ./topic.sh <query> [--since <time>] [--json]"
    echo "Example: ./topic.sh 'tool mapping'"
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
    echo "  \"user_messages\": "
    $RECALL search "$QUERY" --type user_message --since "$SINCE" --limit 15 --format json
    echo ","
    echo "  \"assistant_messages\": "
    $RECALL search "$QUERY" --type assistant_message --since "$SINCE" --limit 10 --format json
    echo ","
    echo "  \"files_mentioned\": "
    $RECALL search "$QUERY" --type tool_call --since "$SINCE" --limit 10 --format json
    echo "}"
else
    echo "=== Topic: \"$QUERY\" (since $SINCE) ==="
    echo ""
    
    echo "--- Your Messages ---"
    $RECALL search "$QUERY" --type user_message --since "$SINCE" --limit 10 2>/dev/null || echo "No mentions found"
    echo ""
    
    echo "--- Agent Responses ---"
    $RECALL search "$QUERY" --type assistant_message --since "$SINCE" --limit 8 2>/dev/null || echo "No responses found"
    echo ""
    
    echo "--- Related Tool Calls ---"
    $RECALL search "$QUERY" --type tool_call --since "$SINCE" --limit 5 2>/dev/null || echo "No tool calls found"
    echo ""
    
    echo "Tip: Use ./session.sh <session_id> to drill into a specific session."
fi
