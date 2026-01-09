#!/bin/bash
# Ground - Orient yourself at the start of a session
# Usage: ./ground.sh [--json]
#
# Shows: current project (from cwd), recent activity, last sessions

set -e

JSON_MODE=false
if [ "$1" = "--json" ] || [ "$1" = "-j" ]; then
    JSON_MODE=true
fi

if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    echo "Usage: ./ground.sh [--json]"
    echo ""
    echo "Orient yourself - shows current project (from cwd), recent activity."
    echo "Run this at the start of any recall investigation."
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

# Get current project from cwd
CWD_PROJECT=$($RECALL projects list --format json 2>/dev/null | grep -B5 "\"root_path\": \"$(pwd)\"" | grep project_id | head -1 | sed 's/.*: "\(.*\)".*/\1/' || echo "")

if [ "$JSON_MODE" = true ]; then
    echo "{"
    echo "  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
    echo "  \"cwd\": \"$(pwd)\","
    if [ -n "$CWD_PROJECT" ]; then
        echo "  \"current_project\": \"$CWD_PROJECT\","
    fi
    echo "  \"projects\": "
    $RECALL projects list --format json
    echo ","
    echo "  \"recent_activity\": "
    $RECALL timeline --last --format json
    echo ","
    if [ -n "$CWD_PROJECT" ]; then
        echo "  \"current_project_timeline\": "
        $RECALL timeline --project "$CWD_PROJECT" --since "4h" --limit 10 --format json
    else
        echo "  \"recent_sessions\": "
        $RECALL timeline --since "4h" --limit 10 --format json
    fi
    echo "}"
else
    echo "=== Recall Ground Check ==="
    echo "Time: $(date)"
    echo "CWD:  $(pwd)"
    
    if [ -n "$CWD_PROJECT" ]; then
        echo "Project: $CWD_PROJECT (auto-detected from cwd)"
        echo ""
        echo "Tip: Use --cwd flag to filter by this project:"
        echo "  recall search \"X\" --cwd --type user_message"
    fi
    echo ""
    
    echo "--- Last Activity (all projects) ---"
    $RECALL timeline --last 2>/dev/null || echo "No recent activity"
    echo ""
    
    if [ -n "$CWD_PROJECT" ]; then
        echo "--- This Project (last 4h) ---"
        $RECALL timeline --project "$CWD_PROJECT" --since "4h" --limit 10 2>/dev/null || echo "No sessions in last 4h"
    else
        echo "--- Recent Sessions (last 4h) ---"
        $RECALL timeline --since "4h" --limit 10 2>/dev/null || echo "No sessions in last 4h"
    fi
    echo ""
    
    echo "Ready. Use --cwd to filter by this project, or:"
    echo "  ./topic.sh \"X\"     - Find conversations about X"
    echo "  ./file.sh path     - File history"
    echo "  ./session.sh       - Current session details"
fi
