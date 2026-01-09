#!/bin/bash
# Recall Uninstaller - Removes all traces of Recall

set -e

echo "🗑️  Recall Uninstaller"
echo "===================="
echo ""

# Stop watcher if running
echo "Stopping watcher daemon..."
if command -v recall &> /dev/null; then
    recall watch off 2>/dev/null || true
fi

# Unlink global binary
echo "Unlinking global 'recall' command..."
npm unlink -g recall 2>/dev/null || true

# Remove database and data directory
DATA_DIR="$HOME/.local/share/recall"
if [ -d "$DATA_DIR" ]; then
    echo "Removing data directory: $DATA_DIR"
    rm -rf "$DATA_DIR"
fi

# Remove watch PID file if it exists elsewhere
PID_FILE="$HOME/.local/share/recall/watch.pid"
if [ -f "$PID_FILE" ]; then
    rm -f "$PID_FILE"
fi

echo ""
echo "✅ Recall fully uninstalled!"
echo ""
echo "Removed:"
echo "  - Global 'recall' command"
echo "  - Database: ~/.local/share/recall/recall.sqlite"
echo "  - Watch daemon PID file"
echo "  - All ingested data"
echo ""
echo "To reinstall: npm install && npm run build && npm link"
