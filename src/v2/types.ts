/**
 * Recall v2: Universal Memory Layer for AI Agent Harnesses
 * Core type definitions
 */

// ============================================================================
// Event Types
// ============================================================================

export type SourceKind = 'claude_code_jsonl' | 'opencode_storage' | 'cursor_transcript' | 'git';

export type EventType =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'file_change'
  | 'command'
  | 'error'
  | 'system'
  | 'git_commit'
  | 'git_diff'
  | 'git_branch'
  | 'git_merge'
  | 'git_stash'
  | 'git_tag';

/**
 * Normalized event - the canonical unit of memory
 */
export interface Event {
  // Identity
  event_id: string;        // Stable unique ID: hash(source_id + source_seq + payload_hash)
  source_id: string;       // Foreign key to sources table
  source_seq: number;      // Sequence within source (for ordering)
  
  // Origin
  device_id: string;       // Which Recall install ingested this
  project_id: string | null; // Derived from git root or cwd
  session_id?: string;     // Native session ID from harness
  
  // Timestamps
  event_ts: string;        // When event occurred (from source)
  ingest_ts: string;       // When Recall ingested it
  
  // Classification
  source_kind: SourceKind;
  event_type: EventType;
  
  // Content
  text_redacted: string;   // Searchable, safe-ish text
  tool_name?: string;      // If tool_call/tool_result
  tool_args_json?: string; // Redacted args
  file_paths?: string[];   // Referenced files
  file_path?: string;      // For diff events (single file)
  old_string?: string;      // For diff events (before content)
  new_string?: string;      // For diff events (after content)
  
  // Metadata
  meta_json?: string;      // Additional structured data
  tags?: string[];         // User/system tags for filtering
  
  // Redaction info
  redaction_manifest_json?: string;
  
  // Encryption
  cipher_id?: number;      // Foreign key to ciphertexts (if storing encrypted original)
}

// ============================================================================
// Source Types
// ============================================================================

export type SourceStatus = 'active' | 'paused' | 'missing' | 'error';

/**
 * Source - where events come from
 */
export interface Source {
  source_id: string;       // UUID
  kind: SourceKind;
  locator: string;         // File path, URL, or connection string
  device_id: string;       // Which device owns this source
  
  // Status
  status: SourceStatus;
  last_seen_at: string;
  error_message?: string;
  
  // Policies
  retain_on_delete: boolean;   // Keep events if source file disappears
  redact_secrets: boolean;     // Apply secret redaction
  encrypt_originals: boolean;  // Store encrypted full payload
  
  created_at: string;
}

// ============================================================================
// Cursor Types (Ingestion Progress)
// ============================================================================

/**
 * Cursor - tracks ingestion progress for a source
 */
export interface Cursor {
  source_id: string;
  
  // For file sources (JSONL)
  file_inode?: number;
  file_size?: number;
  file_mtime?: number;
  byte_offset?: number;
  diff_mtime?: number;
  
  // For stream sources (SSE)
  last_event_id?: string;
  
  // For DB sources
  last_rowid?: number;
  
  updated_at: string;
}

// ============================================================================
// Device Types
// ============================================================================

/**
 * Device - installation identity
 */
export interface Device {
  device_id: string;       // Generated UUID on first run
  nickname: string;        // User-friendly name ("MacBook Pro", "Work Desktop")
  public_key?: string;     // For sync auth + encryption
  created_at: string;
  last_seen_at: string;
}

// ============================================================================
// Project Types
// ============================================================================

export type SharePolicy = 'private' | 'same_project' | 'all_devices';

/**
 * Project - workspace scope
 */
export interface Project {
  project_id: string;      // hash(git_remote + git_root) or hash(cwd)
  display_name: string;    // User-friendly name
  git_remote?: string;     // e.g., "github.com/user/repo"
  root_path: string;       // Absolute path on originating device
  
  // Sharing policy
  share_policy: SharePolicy;
  
  created_at: string;
}

// ============================================================================
// Redaction Types
// ============================================================================

export interface RedactionMatch {
  type: string;
  start: number;
  end: number;
  original_hash: string;  // For verification on unblur
}

export interface RedactionManifest {
  redactions: RedactionMatch[];
}

export interface RedactionPattern {
  pattern: RegExp;
  type: string;
  replacement: string;
}

// ============================================================================
// Git Event Types
// ============================================================================

export interface GitCommitMeta {
  sha: string;
  short_sha: string;
  message: string;
  author_name: string;
  author_email: string;
  commit_ts: string;
  files_changed: number;
  insertions: number;
  deletions: number;
  files: Array<{
    path: string;
    status: 'A' | 'M' | 'D' | 'R';  // Added, Modified, Deleted, Renamed
    insertions: number;
    deletions: number;
  }>;
  branch?: string;
  tags?: string[];
}

export interface GitBranchMeta {
  from_branch: string;
  to_branch: string;
  from_sha: string;
  to_sha: string;
}

// ============================================================================
// Search Types
// ============================================================================

export type MessageRole = 'user' | 'assistant';

export interface SearchRequest {
  query: string;                    // FTS query
  project_id?: string;              // Scope to project (supports wildcards: *recall*)
  session_id?: string;              // Scope to session (supports wildcards)
  event_types?: EventType[];        // Filter by type
  tool_names?: string[];            // Filter by tool (supports wildcards: Parallel*)
  role?: MessageRole;               // Filter messages by role: 'user' or 'assistant'
  since?: string;                   // ISO timestamp
  until?: string;                   // ISO timestamp
  limit?: number;                   // Default 20
  offset?: number;                  // Pagination offset (default: 0)
  rerank?: boolean;                 // Use LLM reranker
}

export interface SearchResult {
  event_id: string;
  event_type: EventType;
  text_redacted: string;
  tool_name?: string;
  tool_args_json?: string;
  session_id?: string;
  project_id?: string | null;
  event_ts: string;
  score: number;
  has_encrypted_original: boolean;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;                    // Total matching results (for pagination)
  timing: {
    search_ms: number;
    rerank_ms?: number;
    total_ms: number;
  };
}

// ============================================================================
// Timeline Types
// ============================================================================

export interface TimelineRequest {
  project_id?: string;              // Scope to project (supports wildcards: *recall*)
  session_id?: string;              // Scope to session (supports wildcards)
  since?: string;                   // ISO timestamp (defaults to all time if not set)
  until?: string;                   // ISO timestamp (defaults to now)
  event_types?: EventType[];        // Filter by type (default: all)
  tool_names?: string[];            // Filter by tool name (Read, Write, etc.) - supports wildcards
  role?: MessageRole;               // Filter messages by role: 'user' or 'assistant'
  include_git?: boolean;            // Include git events (default: true)
  limit?: number;                   // Max events (default: 100)
  offset?: number;                  // Pagination offset (default: 0)
}

export interface TimelineEvent {
  event_id: string;
  event_type: EventType;
  event_ts: string;
  text_redacted: string;
  
  // Type-specific fields
  tool_name?: string;             // For tool_call/tool_result
  tool_args_json?: string;        // For tool_call - the actual parameters passed
  file_paths?: string[];          // For tool_call/tool_result - files operated on
  git_sha?: string;               // For git_commit
  git_files_changed?: number;     // For git_commit
  git_insertions?: number;        // For git_commit
  git_deletions?: number;         // For git_commit
  git_branch?: string;            // For git_branch/git_commit
  
  session_id?: string;
  project_id?: string | null;
  has_encrypted_original: boolean;
}

export interface TimelineResponse {
  events: TimelineEvent[];
  total: number;                    // Total matching events (for pagination)
  
  // Summary stats for the time period
  summary: {
    total_events: number;
    by_type: Record<string, number>;
    time_range: { since?: string; until: string };
    commits_count?: number;
    lines_added?: number;
    lines_removed?: number;
  };
}

// ============================================================================
// Encryption Types
// ============================================================================

export interface Ciphertext {
  cipher_id: number;       // Auto-increment PK
  key_id: string;          // Which key version encrypted this
  algorithm: string;       // 'xchacha20-poly1305'
  nonce: Uint8Array;       // 24 bytes for XChaCha20
  aad: string;             // Associated data: event_id, source_id, device_id
  ciphertext: Uint8Array;  // Encrypted original JSON
  created_at: string;
}
