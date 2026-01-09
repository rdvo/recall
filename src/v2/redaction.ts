/**
 * Recall v2: Secret Redaction Pipeline
 * 
 * Redacts secrets before storage. The original can optionally be encrypted
 * and stored separately for later "unblur" with authentication.
 */

import { createHash } from 'crypto';
import type { RedactionPattern, RedactionManifest, RedactionMatch } from './types.js';

// ============================================================================
// Default Redaction Patterns
// ============================================================================

export const DEFAULT_REDACTION_PATTERNS: RedactionPattern[] = [
  // API Keys - OpenAI/Anthropic style
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, type: 'api_key', replacement: '[REDACTED:api_key]' },
  { pattern: /sk-ant-[a-zA-Z0-9\-]{20,}/g, type: 'anthropic_key', replacement: '[REDACTED:anthropic_key]' },
  
  // Stripe keys
  { pattern: /sk_live_[a-zA-Z0-9]{20,}/g, type: 'stripe_live_key', replacement: '[REDACTED:stripe_key]' },
  { pattern: /sk_test_[a-zA-Z0-9]{20,}/g, type: 'stripe_test_key', replacement: '[REDACTED:stripe_key]' },
  { pattern: /pk_live_[a-zA-Z0-9]{20,}/g, type: 'stripe_live_key', replacement: '[REDACTED:stripe_key]' },
  { pattern: /pk_test_[a-zA-Z0-9]{20,}/g, type: 'stripe_test_key', replacement: '[REDACTED:stripe_key]' },
  { pattern: /whsec_[a-zA-Z0-9]{20,}/g, type: 'stripe_webhook_secret', replacement: '[REDACTED:stripe_webhook]' },
  
  // GitHub tokens
  { pattern: /ghp_[a-zA-Z0-9]{36}/g, type: 'github_pat', replacement: '[REDACTED:github_pat]' },
  { pattern: /gho_[a-zA-Z0-9]{36}/g, type: 'github_oauth', replacement: '[REDACTED:github_oauth]' },
  { pattern: /ghs_[a-zA-Z0-9]{36}/g, type: 'github_server', replacement: '[REDACTED:github_server]' },
  { pattern: /ghu_[a-zA-Z0-9]{36}/g, type: 'github_user', replacement: '[REDACTED:github_user]' },
  { pattern: /github_pat_[a-zA-Z0-9_]{22,}/g, type: 'github_fine_grained', replacement: '[REDACTED:github_pat]' },
  
  // AWS
  { pattern: /AKIA[0-9A-Z]{16}/g, type: 'aws_access_key', replacement: '[REDACTED:aws_key]' },
  { pattern: /(?:aws_secret_access_key|secret_access_key)\s*[=:]\s*["']?([a-zA-Z0-9/+=]{40})["']?/gi, type: 'aws_secret', replacement: '[REDACTED:aws_secret]' },
  
  // Google Cloud
  { pattern: /AIza[a-zA-Z0-9_-]{35}/g, type: 'google_api_key', replacement: '[REDACTED:google_key]' },
  
  // Azure
  { pattern: /[a-zA-Z0-9]{32}\.api\.cognitive\.microsoft\.com/g, type: 'azure_cognitive', replacement: '[REDACTED:azure_key]' },
  
  // Bearer tokens
  { pattern: /Bearer [a-zA-Z0-9\-_.~+/]+=*/g, type: 'bearer_token', replacement: '[REDACTED:bearer_token]' },
  
  // Generic tokens/secrets in config
  { pattern: /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[=:]\s*["']?([a-zA-Z0-9\-_.]{16,})["']?/gi, type: 'generic_token', replacement: '[REDACTED:token]' },
  
  // Passwords in connection strings or config
  { pattern: /(?:password|passwd|pwd)\s*[=:]\s*["']?([^\s"']{8,})["']?/gi, type: 'password', replacement: '[REDACTED:password]' },
  
  // Private keys (PEM format)
  { pattern: /-----BEGIN [A-Z]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z]+ PRIVATE KEY-----/g, type: 'private_key', replacement: '[REDACTED:private_key]' },
  
  // SSH private keys
  { pattern: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g, type: 'ssh_private_key', replacement: '[REDACTED:ssh_key]' },
  
  // Connection strings
  { pattern: /postgres(?:ql)?:\/\/[^@]+:[^@]+@[^\s]+/gi, type: 'postgres_connection', replacement: '[REDACTED:connection_string]' },
  { pattern: /mysql:\/\/[^@]+:[^@]+@[^\s]+/gi, type: 'mysql_connection', replacement: '[REDACTED:connection_string]' },
  { pattern: /mongodb(?:\+srv)?:\/\/[^@]+:[^@]+@[^\s]+/gi, type: 'mongodb_connection', replacement: '[REDACTED:connection_string]' },
  { pattern: /redis:\/\/[^@]*:[^@]+@[^\s]+/gi, type: 'redis_connection', replacement: '[REDACTED:connection_string]' },
  
  // JWT tokens (common format with 3 dot-separated base64 parts)
  { pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g, type: 'jwt_token', replacement: '[REDACTED:jwt]' },
  
  // Slack tokens
  { pattern: /xox[baprs]-[a-zA-Z0-9\-]{10,}/g, type: 'slack_token', replacement: '[REDACTED:slack_token]' },
  
  // Discord tokens
  { pattern: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27}/g, type: 'discord_token', replacement: '[REDACTED:discord_token]' },
  
  // npm tokens
  { pattern: /npm_[a-zA-Z0-9]{36}/g, type: 'npm_token', replacement: '[REDACTED:npm_token]' },
  
  // Twilio
  { pattern: /SK[a-f0-9]{32}/g, type: 'twilio_key', replacement: '[REDACTED:twilio_key]' },
  
  // SendGrid
  { pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g, type: 'sendgrid_key', replacement: '[REDACTED:sendgrid_key]' },
  
  // Mailchimp
  { pattern: /[a-f0-9]{32}-us\d{1,2}/g, type: 'mailchimp_key', replacement: '[REDACTED:mailchimp_key]' },
];

// ============================================================================
// Redaction Functions
// ============================================================================

/**
 * Result of redacting text
 */
export interface RedactionResult {
  text: string;                    // Redacted text
  manifest: RedactionManifest;     // Record of what was redacted
  hadRedactions: boolean;          // Whether any redactions occurred
}

/**
 * Redact secrets from text using default patterns
 */
export function redactSecrets(
  text: string,
  patterns: RedactionPattern[] = DEFAULT_REDACTION_PATTERNS
): RedactionResult {
  const redactions: RedactionMatch[] = [];
  let result = text;
  
  // Track cumulative offset as we make replacements
  let offset = 0;
  
  for (const pattern of patterns) {
    // Reset regex state
    pattern.pattern.lastIndex = 0;
    
    // Find all matches
    const matches: { index: number; length: number; match: string }[] = [];
    let match;
    while ((match = pattern.pattern.exec(text)) !== null) {
      matches.push({
        index: match.index,
        length: match[0].length,
        match: match[0],
      });
    }
    
    // Process matches in reverse order to preserve indices
    for (const m of matches.reverse()) {
      // Calculate position in original text
      const start = m.index;
      const end = start + m.length;
      
      // Create hash of original for verification
      const originalHash = createHash('sha256').update(m.match).digest('hex').slice(0, 16);
      
      redactions.push({
        type: pattern.type,
        start,
        end,
        original_hash: originalHash,
      });
      
      // Replace in result (accounting for previous replacements)
      const beforeLength = result.length;
      result = result.slice(0, start) + pattern.replacement + result.slice(end);
      offset += result.length - beforeLength;
    }
  }
  
  // Sort redactions by start position
  redactions.sort((a, b) => a.start - b.start);
  
  return {
    text: result,
    manifest: { redactions },
    hadRedactions: redactions.length > 0,
  };
}

/**
 * Redact a JSON object by recursively redacting all string values
 */
export function redactJsonObject(
  obj: unknown,
  patterns: RedactionPattern[] = DEFAULT_REDACTION_PATTERNS
): { result: unknown; hadRedactions: boolean } {
  let hadRedactions = false;
  
  function redactValue(value: unknown): unknown {
    if (typeof value === 'string') {
      const redacted = redactSecrets(value, patterns);
      if (redacted.hadRedactions) {
        hadRedactions = true;
      }
      return redacted.text;
    }
    
    if (Array.isArray(value)) {
      return value.map(redactValue);
    }
    
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = redactValue(v);
      }
      return result;
    }
    
    return value;
  }
  
  return {
    result: redactValue(obj),
    hadRedactions,
  };
}

/**
 * Redact tool arguments (JSON string or object)
 */
export function redactToolArgs(args: unknown): string {
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      const { result } = redactJsonObject(parsed);
      return JSON.stringify(result);
    } catch {
      // Not JSON, redact as plain text
      return redactSecrets(args).text;
    }
  }
  
  if (args !== null && typeof args === 'object') {
    const { result } = redactJsonObject(args);
    return JSON.stringify(result);
  }
  
  return String(args);
}

// ============================================================================
// Testing / Debugging
// ============================================================================

/**
 * Test redaction patterns against sample text
 */
export function testRedaction(text: string): { original: string; redacted: string; matches: Array<{ type: string; original: string }> } {
  const matches: Array<{ type: string; original: string }> = [];
  
  for (const pattern of DEFAULT_REDACTION_PATTERNS) {
    pattern.pattern.lastIndex = 0;
    let match;
    while ((match = pattern.pattern.exec(text)) !== null) {
      matches.push({
        type: pattern.type,
        original: match[0].slice(0, 20) + (match[0].length > 20 ? '...' : ''),
      });
    }
  }
  
  const result = redactSecrets(text);
  
  return {
    original: text,
    redacted: result.text,
    matches,
  };
}
