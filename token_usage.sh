#!/bin/bash
# Parse OpenCode message files to get token usage from last 2 hours

STORAGE_DIR="$HOME/.local/share/opencode/storage/message"

echo "================================================"
echo "OPENCODE TOKEN USAGE - Last 2 Hours (Anthropic)"
echo "================================================"
echo ""

# Get all unique sessions from files modified in last 2 hours
sessions=$(find "$STORAGE_DIR" -name "*.json" -mmin -120 2>/dev/null | xargs dirname 2>/dev/null | sort -u)

grand_input=0
grand_output=0
grand_cache_read=0
grand_cache_write=0
grand_reasoning=0
grand_msgs=0

for session_dir in $sessions; do
    session_id=$(basename "$session_dir")
    
    # Get stats for this session (only Anthropic)
    stats=$(find "$session_dir" -name "*.json" -mmin -120 2>/dev/null | while read f; do
        jq -r 'select(.providerID == "anthropic") | "\(.tokens.input // 0) \(.tokens.output // 0) \(.tokens.cache.read // 0) \(.tokens.cache.write // 0) \(.tokens.reasoning // 0)"' "$f" 2>/dev/null
    done | awk '{i+=$1; o+=$2; cr+=$3; cw+=$4; r+=$5; n++} END {print i, o, cr, cw, r, n}')
    
    read input output cache_read cache_write reasoning count <<< "$stats"
    
    if [ "$count" -gt 0 ] 2>/dev/null; then
        total=$((input + output + cache_read + cache_write))
        if [ "$total" -gt 0 ]; then
            echo "Session: $session_id"
            echo "  Messages: $count"
            echo "  Input: $(printf "%'d" $input) | Output: $(printf "%'d" $output)"
            echo "  Cache Read: $(printf "%'d" $cache_read) | Cache Write: $(printf "%'d" $cache_write)"
            echo "  ---"
            
            grand_input=$((grand_input + input))
            grand_output=$((grand_output + output))
            grand_cache_read=$((grand_cache_read + cache_read))
            grand_cache_write=$((grand_cache_write + cache_write))
            grand_reasoning=$((grand_reasoning + reasoning))
            grand_msgs=$((grand_msgs + count))
        fi
    fi
done

echo ""
echo "================================================"
echo "GRAND TOTAL"
echo "================================================"
echo "Total Messages:      $grand_msgs"
echo ""
echo "Input Tokens:        $(printf "%'d" $grand_input)"
echo "Output Tokens:       $(printf "%'d" $grand_output)"
echo "Reasoning Tokens:    $(printf "%'d" $grand_reasoning)"
echo "Cache Read:          $(printf "%'d" $grand_cache_read)"
echo "Cache Write:         $(printf "%'d" $grand_cache_write)"
echo "------------------------------------------------"
grand_total=$((grand_input + grand_output + grand_cache_read + grand_cache_write + grand_reasoning))
echo "TOTAL:               $(printf "%'d" $grand_total)"
echo ""

# Cost calc
cost=$(echo "scale=2; ($grand_input * 3 + $grand_output * 15 + $grand_cache_read * 0.30 + $grand_cache_write * 3.75) / 1000000" | bc)
echo "Estimated Cost:      \$${cost}"
