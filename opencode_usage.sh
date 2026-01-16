#!/bin/bash
# OpenCode Token Usage - Direct file access (real-time)
# Usage: ./opencode_usage.sh [--since TIME] [--by-model|--by-session] [--format json]
#
# Pricing from: https://docs.anthropic.com/en/docs/about-claude/models
# Last updated: 2026-01-10
#
# ┌─────────────────────┬───────────┬───────────┬───────────┬───────────┐
# │ Model               │ Input     │ Output    │ Cache Rd  │ Cache Wr  │
# ├─────────────────────┼───────────┼───────────┼───────────┼───────────┤
# │ Claude Opus 4.5     │ $5/MTok   │ $25/MTok  │ $0.50     │ $6.25     │
# │ Claude Opus 4.1     │ $15/MTok  │ $75/MTok  │ $1.50     │ $18.75    │
# │ Claude Opus 4       │ $15/MTok  │ $75/MTok  │ $1.50     │ $18.75    │
# │ Claude Sonnet 4.5   │ $3/MTok   │ $15/MTok  │ $0.30     │ $3.75     │
# │ Claude Sonnet 4     │ $3/MTok   │ $15/MTok  │ $0.30     │ $3.75     │
# │ Claude Haiku 4.5    │ $1/MTok   │ $5/MTok   │ $0.10     │ $1.25     │
# │ Claude Haiku 3.5    │ $0.80     │ $4/MTok   │ $0.08     │ $1.00     │
# └─────────────────────┴───────────┴───────────┴───────────┴───────────┘
# Cache Read = 0.1x base input, Cache Write (5m) = 1.25x base input

STORAGE_DIR="$HOME/.local/share/opencode/storage/message"

# Parse arguments
TIME_FILTER="2h"  # default
GROUP_BY="total"
FORMAT="table"

while [[ $# -gt 0 ]]; do
    case $1 in
        --since) TIME_FILTER="$2"; shift 2 ;;
        --by-model) GROUP_BY="model"; shift ;;
        --by-session) GROUP_BY="session"; shift ;;
        --format) FORMAT="$2"; shift 2 ;;
        *) echo "Usage: $0 [--since TIME] [--by-model|--by-session] [--format json]"; exit 1 ;;
    esac
done

# Parse time filter to milliseconds
parse_time() {
    local input="$1"
    local now_ms=$(($(date +%s) * 1000))
    
    if [[ "$input" =~ ^([0-9]+)([smhd])$ ]]; then
        local num="${BASH_REMATCH[1]}"
        local unit="${BASH_REMATCH[2]}"
        case $unit in
            s) offset=$((num * 1000)) ;;
            m) offset=$((num * 60 * 1000)) ;;
            h) offset=$((num * 60 * 60 * 1000)) ;;
            d) offset=$((num * 24 * 60 * 60 * 1000)) ;;
        esac
        echo $((now_ms - offset))
    else
        local ts=$(date -j -f "%Y-%m-%d" "$input" "+%s" 2>/dev/null)
        if [ $? -eq 0 ]; then
            echo $((ts * 1000))
        else
            echo "Error: Cannot parse time '$input'. Use: 2h, 30m, 3d, or 2026-01-10" >&2
            exit 1
        fi
    fi
}

CUTOFF_MS=$(parse_time "$TIME_FILTER")

# Extract token data from all messages
tmp_file=$(mktemp)

find "$STORAGE_DIR" -name "*.json" 2>/dev/null | while read f; do
    jq -r --arg cutoff "$CUTOFF_MS" '
        select(.providerID == "anthropic" and .time.created > ($cutoff | tonumber)) |
        "\(.sessionID)\t\(.modelID // "unknown")\t\(.tokens.input // 0)\t\(.tokens.output // 0)\t\(.tokens.cache.read // 0)\t\(.tokens.cache.write // 0)"
    ' "$f" 2>/dev/null
done > "$tmp_file"

total_msgs=$(wc -l < "$tmp_file" | tr -d ' ')

if [ "$total_msgs" -eq 0 ]; then
    echo "No Anthropic messages found since $TIME_FILTER ago."
    rm "$tmp_file"
    exit 0
fi

# Process with AWK - includes full Anthropic pricing table
awk -F'\t' -v group_by="$GROUP_BY" -v time_filter="$TIME_FILTER" '
BEGIN {
    # ════════════════════════════════════════════════════════════════════
    # ANTHROPIC PRICING TABLE (per million tokens)
    # Source: https://docs.anthropic.com/en/docs/about-claude/models
    # Cache Read = 0.1x base input price
    # Cache Write (5min) = 1.25x base input price
    # ════════════════════════════════════════════════════════════════════
    
    # Claude Opus 4.5: $5 input, $25 output
    price["claude-opus-4-5","input"] = 5
    price["claude-opus-4-5","output"] = 25
    price["claude-opus-4-5","cache_read"] = 0.50   # 0.1 × $5
    price["claude-opus-4-5","cache_write"] = 6.25  # 1.25 × $5
    
    # Claude Opus 4.1: $15 input, $75 output
    price["claude-opus-4-1","input"] = 15
    price["claude-opus-4-1","output"] = 75
    price["claude-opus-4-1","cache_read"] = 1.50   # 0.1 × $15
    price["claude-opus-4-1","cache_write"] = 18.75 # 1.25 × $15
    
    # Claude Opus 4: $15 input, $75 output
    price["claude-opus-4","input"] = 15
    price["claude-opus-4","output"] = 75
    price["claude-opus-4","cache_read"] = 1.50
    price["claude-opus-4","cache_write"] = 18.75
    
    # Claude Sonnet 4.5: $3 input, $15 output
    price["claude-sonnet-4-5","input"] = 3
    price["claude-sonnet-4-5","output"] = 15
    price["claude-sonnet-4-5","cache_read"] = 0.30  # 0.1 × $3
    price["claude-sonnet-4-5","cache_write"] = 3.75 # 1.25 × $3
    
    # Claude Sonnet 4.5 dated variants
    price["claude-sonnet-4-5-20250929","input"] = 3
    price["claude-sonnet-4-5-20250929","output"] = 15
    price["claude-sonnet-4-5-20250929","cache_read"] = 0.30
    price["claude-sonnet-4-5-20250929","cache_write"] = 3.75
    
    # Claude Sonnet 4: $3 input, $15 output
    price["claude-sonnet-4","input"] = 3
    price["claude-sonnet-4","output"] = 15
    price["claude-sonnet-4","cache_read"] = 0.30
    price["claude-sonnet-4","cache_write"] = 3.75
    
    # Claude Haiku 4.5: $1 input, $5 output
    price["claude-haiku-4-5","input"] = 1
    price["claude-haiku-4-5","output"] = 5
    price["claude-haiku-4-5","cache_read"] = 0.10  # 0.1 × $1
    price["claude-haiku-4-5","cache_write"] = 1.25 # 1.25 × $1
    
    # Claude Haiku 3.5: $0.80 input, $4 output
    price["claude-haiku-3-5","input"] = 0.80
    price["claude-haiku-3-5","output"] = 4
    price["claude-haiku-3-5","cache_read"] = 0.08  # 0.1 × $0.80
    price["claude-haiku-3-5","cache_write"] = 1.00 # 1.25 × $0.80
}
{
    session = $1
    model = $2
    input = $3
    output = $4
    cache_read = $5
    cache_write = $6
    
    # Accumulate by model
    models[model]++
    m_input[model] += input
    m_output[model] += output
    m_cache_read[model] += cache_read
    m_cache_write[model] += cache_write
    
    # Also by session
    sessions[session]++
    s_input[session] += input
    s_output[session] += output
    s_cache_read[session] += cache_read
    s_cache_write[session] += cache_write
    s_model[session] = model
    
    # Grand totals
    total_input += input
    total_output += output
    total_cache_read += cache_read
    total_cache_write += cache_write
    total_msgs++
}
END {
    printf "════════════════════════════════════════════════════\n"
    printf "  OPENCODE TOKEN USAGE (Anthropic)\n"
    printf "════════════════════════════════════════════════════\n"
    printf "Time filter: Last %s\n", time_filter
    printf "Messages:    %d\n\n", total_msgs
    
    grand_cost = 0
    
    if (group_by == "model" || group_by == "total") {
        printf "BY MODEL:\n"
        printf "────────────────────────────────────────────────────\n"
        for (model in models) {
            p_in = price[model,"input"]
            p_out = price[model,"output"]
            p_cr = price[model,"cache_read"]
            p_cw = price[model,"cache_write"]
            
            # Default to Sonnet 4.5 pricing if unknown
            if (p_in == 0) { p_in = 3; p_out = 15; p_cr = 0.30; p_cw = 3.75 }
            
            cost = (m_input[model] * p_in + m_output[model] * p_out + m_cache_read[model] * p_cr + m_cache_write[model] * p_cw) / 1000000
            grand_cost += cost
            
            printf "\n%s (%d msgs)\n", model, models[model]
            printf "  Input:       %'"'"'12d tokens × $%.2f/MTok\n", m_input[model], p_in
            printf "  Output:      %'"'"'12d tokens × $%.2f/MTok\n", m_output[model], p_out
            printf "  Cache Read:  %'"'"'12d tokens × $%.2f/MTok\n", m_cache_read[model], p_cr
            printf "  Cache Write: %'"'"'12d tokens × $%.2f/MTok\n", m_cache_write[model], p_cw
            printf "  ────────────────────────────\n"
            printf "  Cost:        $%.2f\n", cost
        }
    }
    
    if (group_by == "session") {
        printf "BY SESSION:\n"
        printf "────────────────────────────────────────────────────\n"
        n = 0
        for (sess in sessions) {
            n++
            model = s_model[sess]
            p_in = price[model,"input"]
            p_out = price[model,"output"]
            p_cr = price[model,"cache_read"]
            p_cw = price[model,"cache_write"]
            
            if (p_in == 0) { p_in = 3; p_out = 15; p_cr = 0.30; p_cw = 3.75 }
            
            cost = (s_input[sess] * p_in + s_output[sess] * p_out + s_cache_read[sess] * p_cr + s_cache_write[sess] * p_cw) / 1000000
            grand_cost += cost
            
            if (n <= 10) {
                printf "\n%s\n", substr(sess, 1, 45)
                printf "  Model: %s (%d msgs) | Output: %'"'"'d | Cost: $%.2f\n", model, sessions[sess], s_output[sess], cost
            }
        }
        if (n > 10) printf "\n... and %d more sessions\n", n - 10
    }
    
    # Recalculate grand cost for non-model views
    if (group_by != "model" && group_by != "total") {
        grand_cost = 0
        for (model in models) {
            p_in = price[model,"input"]
            p_out = price[model,"output"]
            p_cr = price[model,"cache_read"]
            p_cw = price[model,"cache_write"]
            if (p_in == 0) { p_in = 3; p_out = 15; p_cr = 0.30; p_cw = 3.75 }
            grand_cost += (m_input[model] * p_in + m_output[model] * p_out + m_cache_read[model] * p_cr + m_cache_write[model] * p_cw) / 1000000
        }
    }
    
    printf "\n════════════════════════════════════════════════════\n"
    printf "  TOTALS\n"
    printf "════════════════════════════════════════════════════\n"
    printf "Input:       %'"'"'12d tokens\n", total_input
    printf "Output:      %'"'"'12d tokens\n", total_output
    printf "Cache Read:  %'"'"'12d tokens\n", total_cache_read
    printf "Cache Write: %'"'"'12d tokens\n", total_cache_write
    printf "────────────────────────────────────────────────────\n"
    printf "TOTAL COST:  $%.2f\n", grand_cost
    printf "════════════════════════════════════════════════════\n"
}
' "$tmp_file"

rm "$tmp_file"