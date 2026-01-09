/**
 * Recall v2: SQLite Schema and Migrations
 */

export const SCHEMA_VERSION = 2;

/**
 * Initial schema for Recall v2
 */
export const SCHEMA_V1 = `
-- Enable WAL for concurrent read/write
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);

-- Devices (this install and known peers)
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  public_key TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT DEFAULT (datetime('now'))
);

-- Projects (workspace scopes)
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  git_remote TEXT,
  root_path TEXT NOT NULL,
  share_policy TEXT DEFAULT 'private',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Sources (ingestion feeds)
CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  locator TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  status TEXT DEFAULT 'active',
  last_seen_at TEXT,
  error_message TEXT,
  retain_on_delete INTEGER DEFAULT 1,
  redact_secrets INTEGER DEFAULT 1,
  encrypt_originals INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Cursors (ingestion progress)
CREATE TABLE IF NOT EXISTS cursors (
  source_id TEXT PRIMARY KEY REFERENCES sources(source_id) ON DELETE CASCADE,
  file_inode INTEGER,
  file_size INTEGER,
  file_mtime INTEGER,
  byte_offset INTEGER,
  last_event_id TEXT,
  last_rowid INTEGER,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Encrypted originals
CREATE TABLE IF NOT EXISTS ciphertexts (
  cipher_id INTEGER PRIMARY KEY,
  key_id TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  nonce BLOB NOT NULL,
  aad TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Events (normalized memory)
CREATE TABLE IF NOT EXISTS events (
  event_rowid INTEGER PRIMARY KEY,
  event_id TEXT UNIQUE NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  source_seq INTEGER NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  project_id TEXT REFERENCES projects(project_id),
  session_id TEXT,
  event_ts TEXT,
  ingest_ts TEXT DEFAULT (datetime('now')),
  source_kind TEXT NOT NULL,
  event_type TEXT NOT NULL,
  text_redacted TEXT NOT NULL,
  tool_name TEXT,
  tool_args_json TEXT,
  file_paths_json TEXT,
  meta_json TEXT,
  tags_json TEXT,
  redaction_manifest_json TEXT,
  cipher_id INTEGER REFERENCES ciphertexts(cipher_id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(event_ts);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source_id, source_seq);
CREATE INDEX IF NOT EXISTS idx_events_ingest ON events(ingest_ts);

-- FTS5 for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  text_redacted,
  tool_name,
  content='events',
  content_rowid='event_rowid',
  tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, text_redacted, tool_name)
  VALUES (NEW.event_rowid, NEW.text_redacted, NEW.tool_name);
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text_redacted, tool_name)
  VALUES ('delete', OLD.event_rowid, OLD.text_redacted, OLD.tool_name);
END;

CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text_redacted, tool_name)
  VALUES ('delete', OLD.event_rowid, OLD.text_redacted, OLD.tool_name);
  INSERT INTO events_fts(rowid, text_redacted, tool_name)
  VALUES (NEW.event_rowid, NEW.text_redacted, NEW.tool_name);
END;

-- Record schema version
INSERT OR IGNORE INTO schema_version (version) VALUES (1);
`;

/**
 * Schema v2: Symbol indexing for code understanding
 */
export const SCHEMA_V2 = `
-- Symbols table for functions, classes, methods, imports, etc.
CREATE TABLE IF NOT EXISTS symbols (
  symbol_id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  symbol_name TEXT NOT NULL,
  symbol_kind TEXT NOT NULL,  -- function, class, method, variable, import, export, interface, type
  language TEXT NOT NULL,      -- typescript, javascript, python, etc.
  line_start INTEGER,
  line_end INTEGER,
  column_start INTEGER,
  column_end INTEGER,
  signature TEXT,              -- function signature or type annotation
  parent_symbol TEXT,          -- for nested (class name if method)
  docstring TEXT,              -- first line of docstring/JSDoc
  is_exported INTEGER DEFAULT 0,
  is_async INTEGER DEFAULT 0,
  event_id TEXT,               -- which event captured this
  project_id TEXT REFERENCES projects(project_id),
  indexed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(file_path, symbol_name, symbol_kind, line_start)
);

-- Indexes for symbol queries
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(symbol_name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(symbol_kind);
CREATE INDEX IF NOT EXISTS idx_symbols_language ON symbols(language);
CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_symbol);
CREATE INDEX IF NOT EXISTS idx_symbols_project ON symbols(project_id);

-- FTS for symbol name search
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  symbol_name,
  file_path,
  signature,
  content='symbols',
  content_rowid='symbol_id',
  tokenize='porter unicode61'
);

-- Triggers to keep symbols FTS in sync
CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
  INSERT INTO symbols_fts(rowid, symbol_name, file_path, signature)
  VALUES (NEW.symbol_id, NEW.symbol_name, NEW.file_path, NEW.signature);
END;

CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, symbol_name, file_path, signature)
  VALUES ('delete', OLD.symbol_id, OLD.symbol_name, OLD.file_path, OLD.signature);
END;

-- Record schema version
INSERT OR IGNORE INTO schema_version (version) VALUES (2);
`;

/**
 * All migrations in order
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
];
