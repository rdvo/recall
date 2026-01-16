#!/bin/bash
# Accurate OpenCode token usage - last 2 hours 10 minutes

STORAGE_DIR="$HOME/.local/share/opencode/storage/message"
NOW_MS=$(($(date +%s) * 1000))
# 2 hours 10 minutes = 130 minutes = 7800 seconds
CUTOFF_MS=$((NOW_MS - 7800000))

echo "================================================"
echo "OPENCODE TOKEN USAGE - Last 2h 10m (Anthropic)"
echo "================================================"
echo "Now: $(date)"
echo "Cutoff: $(date -r $((CUTOFF_MS / 1000)))"
echo ""

# Temp file for aggregation
tmp_file=$(mktemp)

# Find ALL message files, filter by creation timestamp in JSON
find "$STORAGE_DIR" -name "*.json" 2>/dev/null | while read f; do
    jq -r --arg cutoff "$CUTOFF_MS" '
        select(.providerID == "anthropic" and .time.created > ($cutoff | tonumber)) |
        "\(.modelID // "unknown")\t\(.tokens.input // 0)\t\(.tokens.output // 0)\t\(.tokens.cache.read // 0)\t\(.tokens.cache.write // 0)"
    ' "$f" 2>/dev/null
done > "$tmp_file"

total_msgs=$(wc -l < "$tmp_file" | tr -d ' ')

if [ "$total_msgs" -eq 0 ]; then
    echo "No Anthropic messages found."
    rm "$tmp_file"
    exit 0
fi

echo "Messages: $total_msgs"
echo ""

awk -F'\t' '
BEGIN {
    # Pricing per MTok from Anthropic docs
    # Format: base_input, output, cache_read (0.1x base), cache_write_5m (1.25x base)
    
    # Claude Opus 4.5: $5 input, $25 output
    price["claude-opus-4-5","input"] = 5
    price["claude-opus-4-5","output"] = 25
    price["claude-opus-4-5","cache_read"] = 0.50    # 0.1x of $5
    price["claude-opus-4-5","cache_write"] = 6.25   # 1.25x of $5
    
    # Claude Sonnet 4.5: $3 input, $15 output  
    price["claude-sonnet-4-5","input"] = 3
    price["claude-sonnet-4-5","output"] = 15
    price["claude-sonnet-4-5","cache_read"] = 0.30   # 0.1x of $3
    price["claude-sonnet-4-5","cache_write"] = 3.75  # 1.25x of $3
    
    # Claude Sonnet 4.5 dated version (same pricing)
    price["claude-sonnet-4-5-20250929","input"] = 3
    price["claude-sonnet-4-5-20250929","output"] = 15
    price["claude-sonnet-4-5-20250929","cache_read"] = 0.30
    price["claude-sonnet-4-5-20250929","cache_write"] = 3.75
    
    # Claude Haiku 4.5: $1 input, $5 output
    price["claude-haiku-4-5","input"] = 1
    price["claude-haiku-4-5","output"] = 5
    price["claude-haiku-4-5","cache_read"] = 0.10    # 0.1x of $1
    price["claude-haiku-4-5","cache_write"] = 1.25   # 1.25x of $1
}
{
    model = $1
    input = $2
    output = $3
    cache_read = $4
    cache_write = $5
    
    models[model]++
    m_input[model] += input
    m_output[model] += output
    m_cache_read[model] += cache_read
    m_cache_write[model] += cache_write
    
    total_input += input
    total_output += output
    total_cache_read += cache_read
    total_cache_write += cache_write
}
END {
    printf "================================================\n"
    printf "USAGE BY MODEL\n"
    printf "================================================\n"
    
    grand_cost = 0
    
    for (model in models) {
        printf "\n%s (%d messages)\n", model, models[model]
        printf "  Input:       %'"'"'12d tokens\n", m_input[model]
        printf "  Output:      %'"'"'12d tokens\n", m_output[model]
        printf "  Cache Read:  %'"'"'12d tokens\n", m_cache_read[model]
        printf "  Cache Write: %'"'"'12d tokens\n", m_cache_write[model]
        
        # Calculate cost for this model
        p_in = price[model,"input"]
        p_out = price[model,"output"]
        p_cr = price[model,"cache_read"]
        p_cw = price[model,"cache_write"]
        
        if (p_in == 0) {
            printf "  [WARNING: Unknown model pricing, using Sonnet 4.5]\n"
            p_in = 3; p_out = 15; p_cr = 0.30; p_cw = 3.75
        }
        
        cost = (m_input[model] * p_in + m_output[model] * p_out + m_cache_read[model] * p_cr + m_cache_write[model] * p_cw) / 1000000
        printf "  COST:        $%.2f\n", cost
        grand_cost += cost
    }
    
    printf "\n================================================\n"
    printf "GRAND TOTAL\n"
    printf "================================================\n"
    printf "Input Tokens:      %'"'"'d\n", total_input
    printf "Output Tokens:     %'"'"'d\n", total_output
    printf "Cache Read:        %'"'"'d\n", total_cache_read
    printf "Cache Write:       %'"'"'d\n", total_cache_write
    printf "------------------------------------------------\n"
    raw_total = total_input + total_output + total_cache_read + total_cache_write
    printf "RAW TOTAL:         %'"'"'d\n", raw_total
    printf "\n"
    printf "================================================\n"
    printf "TOTAL COST:        $%.2f\n", grand_cost
    printf "================================================\n"
}' "$tmp_file"

rm "$tmp_file"