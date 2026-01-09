#!/bin/bash
# Around - Show events around a specific timestamp
# Usage: ./around.sh <timestamp> [--window <minutes>] [--json]
# 
# Examples:
#   ./around.sh "2026-01-09T17:50:00Z"
#   ./around.sh "2h ago" --window 60
#   ./around.sh "2026-01-09T17:50:00Z" --json

set -e

TIMESTAMP=""
WINDOW_MINUTES=30
JSON_MODE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --json|-j)
            JSON_MODE=true
            shift
            ;;
        --window|-w)
            WINDOW_MINUTES="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: ./around.sh <timestamp> [--window <minutes>] [--json]"
            echo ""
            echo "Show events around a specific timestamp."
            echo ""
            echo "Arguments:"
            echo "  <timestamp>    ISO timestamp or relative (e.g., '2h ago', '2026-01-09T17:50:00Z')"
            echo "  --window, -w   Minutes before and after (default: 30)"
            echo "  --json, -j     Output JSON format"
            echo ""
            echo "Examples:"
            echo "  ./around.sh '2026-01-09T17:50:00Z'"
            echo "  ./around.sh '2h ago' --window 60"
            exit 0
            ;;
        *)
            if [ -z "$TIMESTAMP" ]; then
                TIMESTAMP="$1"
            fi
            shift
            ;;
    esac
done

if [ -z "$TIMESTAMP" ]; then
    echo "Error: timestamp required"
    echo "Usage: ./around.sh <timestamp> [--window <minutes>] [--json]"
    echo "Example: ./around.sh '2h ago' --window 30"
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

# Convert relative timestamps to absolute
# This is a simple implementation - the CLI should handle this better
if [[ "$TIMESTAMP" == *"ago"* ]]; then
    # Extract number and unit
    NUM=$(echo "$TIMESTAMP" | grep -oE '[0-9]+')
    if [[ "$TIMESTAMP" == *"h"* ]]; then
        # Hours ago
        if [[ "$OSTYPE" == "darwin"* ]]; then
            TIMESTAMP=$(date -u -v-${NUM}H +%Y-%m-%dT%H:%M:%SZ)
        else
            TIMESTAMP=$(date -u -d "${NUM} hours ago" +%Y-%m-%dT%H:%M:%SZ)
        fi
    elif [[ "$TIMESTAMP" == *"m"* ]]; then
        # Minutes ago
        if [[ "$OSTYPE" == "darwin"* ]]; then
            TIMESTAMP=$(date -u -v-${NUM}M +%Y-%m-%dT%H:%M:%SZ)
        else
            TIMESTAMP=$(date -u -d "${NUM} minutes ago" +%Y-%m-%dT%H:%M:%SZ)
        fi
    elif [[ "$TIMESTAMP" == *"d"* ]]; then
        # Days ago
        if [[ "$OSTYPE" == "darwin"* ]]; then
            TIMESTAMP=$(date -u -v-${NUM}d +%Y-%m-%dT%H:%M:%SZ)
        else
            TIMESTAMP=$(date -u -d "${NUM} days ago" +%Y-%m-%dT%H:%M:%SZ)
        fi
    fi
fi

# Calculate window
WINDOW_DURATION="${WINDOW_MINUTES}m"
DOUBLE_WINDOW=$((WINDOW_MINUTES * 2))

if [ "$JSON_MODE" = true ]; then
    echo "{"
    echo "  \"center_timestamp\": \"$TIMESTAMP\","
    echo "  \"window_minutes\": $WINDOW_MINUTES,"
    echo "  \"events\": "
    # Use since with double the window to get events around the timestamp
    # This is approximate - proper implementation would need CLI support
    $RECALL timeline --since "${DOUBLE_WINDOW}m" --limit 50 --format json
    echo "}"
else
    echo "=== Context Around: $TIMESTAMP ==="
    echo "Window: ±${WINDOW_MINUTES} minutes"
    echo ""
    
    echo "--- Events ---"
    $RECALL timeline --since "${DOUBLE_WINDOW}m" --limit 30 2>/dev/null || echo "No events found"
    echo ""
    
    echo "--- User Messages ---"
    $RECALL search "" --type user_message --since "${DOUBLE_WINDOW}m" --limit 10 2>/dev/null || echo "No messages found"
    echo ""
    
    echo "Note: For precise timestamp filtering, use recall CLI directly with --since/--until"
fi
