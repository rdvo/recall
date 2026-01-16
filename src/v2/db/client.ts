/**
 * Recall v2: SQLite Database Client
 */

import Database from 'better-sqlite3';
import { SCHEMA_VERSION, MIGRATIONS } from './schema.js';
import type {
  Event,
  Source,
  Cursor,
  Device,
  Project,
  SearchRequest,
  SearchResult,
  SearchResponse,
  TimelineRequest,
  TimelineEvent,
  TimelineResponse,
  EventType,
} from '../types.js';


export class RecallDB {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath: string = './store/recall-v2.sqlite') {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.migrate();
  }

  /**
   * Run migrations to bring schema up to date
   */
  private migrate() {
    // Get current version
    let currentVersion = 0;
    try {
      const row = this.db.prepare('SELECT MAX(version) as version FROM schema_version').get() as { version: number } | undefined;
      currentVersion = row?.version ?? 0;
    } catch {
      // Table doesn't exist yet, version is 0
    }

    // Apply needed migrations
    for (const migration of MIGRATIONS) {
      if (migration.version > currentVersion) {
        console.log(`Applying migration v${migration.version}...`);
        this.db.exec(migration.sql);
        currentVersion = migration.version;
      }
    }
  }

  // ============================================================================
  // Generic Query Helper
  // ============================================================================

  /**
   * Run a read-only query and return results
   */
  query<T = any>(sql: string, params: any[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  // ============================================================================
  // Device Operations
  // ============================================================================

  getDevice(deviceId: string): Device | undefined {
    const row = this.db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId) as any;
    return row ? this.rowToDevice(row) : undefined;
  }

  getOrCreateDevice(deviceId: string, nickname: string): Device {
    const existing = this.getDevice(deviceId);
    if (existing) {
      // Update last_seen_at
      this.db.prepare("UPDATE devices SET last_seen_at = datetime('now') WHERE device_id = ?").run(deviceId);
      return { ...existing, last_seen_at: new Date().toISOString() };
    }

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO devices (device_id, nickname, created_at, last_seen_at)
      VALUES (?, ?, ?, ?)
    `).run(deviceId, nickname, now, now);

    return {
      device_id: deviceId,
      nickname,
      created_at: now,
      last_seen_at: now,
    };
  }

  listDevices(): Device[] {
    const rows = this.db.prepare('SELECT * FROM devices ORDER BY last_seen_at DESC').all() as any[];
    return rows.map(this.rowToDevice);
  }

  private rowToDevice(row: any): Device {
    return {
      device_id: row.device_id,
      nickname: row.nickname,
      public_key: row.public_key,
      created_at: row.created_at,
      last_seen_at: row.last_seen_at,
    };
  }

  // ============================================================================
  // Project Operations
  // ============================================================================

  getProject(projectId: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as any;
    return row ? this.rowToProject(row) : undefined;
  }

  /**
   * Resolve a project identifier to the actual project_id
   * Accepts: full project_id, display_name, partial match, or path
   * Returns the project_id or undefined if not found
   */
  resolveProjectId(identifier: string): string | undefined {
    // Don't resolve if it contains wildcards - let the query handle it
    if (identifier.includes('*') || identifier.includes('%')) {
      return identifier;
    }
    
    // Try exact match on project_id first
    const exactMatch = this.db.prepare('SELECT project_id FROM projects WHERE project_id = ?').get(identifier) as any;
    if (exactMatch) return exactMatch.project_id;
    
    // Try exact match on display_name
    const displayMatch = this.db.prepare('SELECT project_id FROM projects WHERE display_name = ?').get(identifier) as any;
    if (displayMatch) return displayMatch.project_id;
    
    // Try exact match on root_path (for cwd-based lookup)
    const pathMatch = this.db.prepare('SELECT project_id FROM projects WHERE root_path = ?').get(identifier) as any;
    if (pathMatch) return pathMatch.project_id;
    
    // Try partial match on project_id (starts with)
    const partialIdMatch = this.db.prepare('SELECT project_id FROM projects WHERE project_id LIKE ? LIMIT 1').get(identifier + '%') as any;
    if (partialIdMatch) return partialIdMatch.project_id;
    
    // Try partial match on display_name (contains)
    const partialNameMatch = this.db.prepare('SELECT project_id FROM projects WHERE display_name LIKE ? LIMIT 1').get('%' + identifier + '%') as any;
    if (partialNameMatch) return partialNameMatch.project_id;
    
    // Try path contains (for subdirectory lookup)
    const subPathMatch = this.db.prepare('SELECT project_id FROM projects WHERE ? LIKE root_path || \'%\' ORDER BY length(root_path) DESC LIMIT 1').get(identifier) as any;
    if (subPathMatch) return subPathMatch.project_id;
    
    return undefined;
  }
  
  /**
   * Get project by root path (exact or parent match)
   */
  getProjectByPath(path: string): Project | undefined {
    // Try exact match first
    const exact = this.db.prepare('SELECT * FROM projects WHERE root_path = ?').get(path) as any;
    if (exact) return this.rowToProject(exact);
    
    // Try finding project whose root_path is a parent of the given path
    // Order by path length descending to get the most specific match
    const parent = this.db.prepare(`
      SELECT * FROM projects 
      WHERE ? LIKE root_path || '%'
      ORDER BY length(root_path) DESC 
      LIMIT 1
    `).get(path) as any;
    
    return parent ? this.rowToProject(parent) : undefined;
  }

  getOrCreateProject(project: Omit<Project, 'created_at'>): Project {
    const existing = this.getProject(project.project_id);
    if (existing) return existing;

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO projects (project_id, display_name, git_remote, root_path, share_policy, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      project.project_id,
      project.display_name,
      project.git_remote ?? null,
      project.root_path,
      project.share_policy,
      now
    );

    return { ...project, created_at: now };
  }

  listProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as any[];
    return rows.map(this.rowToProject);
  }

  /**
   * Get project status summary (last activity for each project)
   */
  getProjectsStatus(): Array<{
    project_id: string;
    display_name: string;
    last_user_message?: { text: string; ts: string };
    last_assistant_message?: { text: string; ts: string };
    last_git_commit?: { message: string; ts: string; sha: string };
    last_tool_call?: { tool: string; ts: string; file_paths?: string[] };
  }> {
    const projects = this.listProjects();
    const results = [];

    for (const project of projects) {
      const status: any = {
        project_id: project.project_id,
        display_name: project.display_name,
      };

      // Last user message
      const lastUser = this.db.prepare(`
        SELECT text_redacted, event_ts 
        FROM events 
        WHERE project_id = ? AND event_type = 'user_message'
        ORDER BY event_ts DESC 
        LIMIT 1
      `).get(project.project_id) as any;
      if (lastUser) {
        status.last_user_message = { text: lastUser.text_redacted, ts: lastUser.event_ts };
      }

      // Last assistant message
      const lastAssistant = this.db.prepare(`
        SELECT text_redacted, event_ts 
        FROM events 
        WHERE project_id = ? AND event_type = 'assistant_message'
        ORDER BY event_ts DESC 
        LIMIT 1
      `).get(project.project_id) as any;
      if (lastAssistant) {
        status.last_assistant_message = { text: lastAssistant.text_redacted, ts: lastAssistant.event_ts };
      }

      // Last git commit
      const lastCommit = this.db.prepare(`
        SELECT text_redacted, event_ts, meta_json 
        FROM events 
        WHERE project_id = ? AND event_type = 'git_commit'
        ORDER BY event_ts DESC 
        LIMIT 1
      `).get(project.project_id) as any;
      if (lastCommit) {
        const meta = lastCommit.meta_json ? JSON.parse(lastCommit.meta_json) : {};
        status.last_git_commit = { 
          message: lastCommit.text_redacted, 
          ts: lastCommit.event_ts,
          sha: meta.sha || 'unknown'
        };
      }

      // Last tool call
      const lastTool = this.db.prepare(`
        SELECT tool_name, event_ts, file_paths_json
        FROM events 
        WHERE project_id = ? AND event_type = 'tool_call' AND tool_name IS NOT NULL
        ORDER BY event_ts DESC 
        LIMIT 1
      `).get(project.project_id) as any;
      if (lastTool) {
        let filePaths: string[] | undefined;
        if (lastTool.file_paths_json) {
          try {
            const parsed = JSON.parse(lastTool.file_paths_json);
            if (Array.isArray(parsed)) filePaths = parsed.map(String);
          } catch {}
        }
        status.last_tool_call = { tool: lastTool.tool_name, ts: lastTool.event_ts, file_paths: filePaths };
      }

      results.push(status);
    }

    return results;
  }

  private rowToProject(row: any): Project {
    return {
      project_id: row.project_id,
      display_name: row.display_name,
      git_remote: row.git_remote,
      root_path: row.root_path,
      share_policy: row.share_policy,
      created_at: row.created_at,
    };
  }

  // ============================================================================
  // Source Operations
  // ============================================================================

  getSource(sourceId: string): Source | undefined {
    const row = this.db.prepare('SELECT * FROM sources WHERE source_id = ?').get(sourceId) as any;
    return row ? this.rowToSource(row) : undefined;
  }

  getSourceByLocator(locator: string, deviceId: string): Source | undefined {
    const row = this.db.prepare(
      'SELECT * FROM sources WHERE locator = ? AND device_id = ?'
    ).get(locator, deviceId) as any;
    return row ? this.rowToSource(row) : undefined;
  }

  createSource(source: Omit<Source, 'created_at' | 'last_seen_at'>): Source {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO sources (source_id, kind, locator, device_id, status, last_seen_at, error_message, retain_on_delete, redact_secrets, encrypt_originals, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      source.source_id,
      source.kind,
      source.locator,
      source.device_id,
      source.status,
      now,
      source.error_message ?? null,
      source.retain_on_delete ? 1 : 0,
      source.redact_secrets ? 1 : 0,
      source.encrypt_originals ? 1 : 0,
      now
    );

    return { ...source, created_at: now, last_seen_at: now };
  }

  updateSourceStatus(sourceId: string, status: Source['status'], errorMessage?: string) {
    this.db.prepare(`
      UPDATE sources SET status = ?, error_message = ?, last_seen_at = datetime('now')
      WHERE source_id = ?
    `).run(status, errorMessage ?? null, sourceId);
  }

  updateSourceLocator(sourceId: string, locator: string) {
    this.db.prepare(`
      UPDATE sources SET locator = ?, last_seen_at = datetime('now')
      WHERE source_id = ?
    `).run(locator, sourceId);
  }

  listSources(deviceId?: string): Source[] {
    if (deviceId) {
      const rows = this.db.prepare('SELECT * FROM sources WHERE device_id = ? ORDER BY created_at DESC').all(deviceId) as any[];
      return rows.map(this.rowToSource);
    }
    const rows = this.db.prepare('SELECT * FROM sources ORDER BY created_at DESC').all() as any[];
    return rows.map(this.rowToSource);
  }

  deleteSource(sourceId: string, purgeEvents: boolean = false) {
    if (purgeEvents) {
      this.db.prepare('DELETE FROM events WHERE source_id = ?').run(sourceId);
    }
    this.db.prepare('DELETE FROM cursors WHERE source_id = ?').run(sourceId);
    this.db.prepare('DELETE FROM sources WHERE source_id = ?').run(sourceId);
  }

  private rowToSource(row: any): Source {
    return {
      source_id: row.source_id,
      kind: row.kind,
      locator: row.locator,
      device_id: row.device_id,
      status: row.status,
      last_seen_at: row.last_seen_at,
      error_message: row.error_message,
      retain_on_delete: Boolean(row.retain_on_delete),
      redact_secrets: Boolean(row.redact_secrets),
      encrypt_originals: Boolean(row.encrypt_originals),
      created_at: row.created_at,
    };
  }

  // ============================================================================
  // Cursor Operations
  // ============================================================================

  getCursor(sourceId: string): Cursor | undefined {
    const row = this.db.prepare('SELECT * FROM cursors WHERE source_id = ?').get(sourceId) as any;
    return row ? this.rowToCursor(row) : undefined;
  }

  upsertCursor(cursor: Cursor) {
    this.db.prepare(`
      INSERT INTO cursors (source_id, file_inode, file_size, file_mtime, byte_offset, last_event_id, last_rowid, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        file_inode = excluded.file_inode,
        file_size = excluded.file_size,
        file_mtime = excluded.file_mtime,
        byte_offset = excluded.byte_offset,
        last_event_id = excluded.last_event_id,
        last_rowid = excluded.last_rowid,
        updated_at = excluded.updated_at
    `).run(
      cursor.source_id,
      cursor.file_inode ?? null,
      cursor.file_size ?? null,
      cursor.file_mtime ?? null,
      cursor.byte_offset ?? null,
      cursor.last_event_id ?? null,
      cursor.last_rowid ?? null,
      cursor.updated_at
    );
  }

  private rowToCursor(row: any): Cursor {
    return {
      source_id: row.source_id,
      file_inode: row.file_inode,
      file_size: row.file_size,
      file_mtime: row.file_mtime,
      byte_offset: row.byte_offset,
      last_event_id: row.last_event_id,
      last_rowid: row.last_rowid,
      updated_at: row.updated_at,
    };
  }

  // ============================================================================
  // Event Operations
  // ============================================================================

  insertEvent(event: Event): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO events (
        event_id, source_id, source_seq, device_id, project_id, session_id,
        event_ts, ingest_ts, source_kind, event_type, text_redacted,
        tool_name, tool_args_json, file_paths_json, meta_json, tags_json,
        redaction_manifest_json, cipher_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.event_id,
      event.source_id,
      event.source_seq,
      event.device_id,
      event.project_id,
      event.session_id ?? null,
      event.event_ts,
      event.ingest_ts,
      event.source_kind,
      event.event_type,
      event.text_redacted,
      event.tool_name ?? null,
      event.tool_args_json ?? null,
      event.file_paths ? JSON.stringify(event.file_paths) : null,
      event.meta_json ?? null,
      event.tags ? JSON.stringify(event.tags) : null,
      event.redaction_manifest_json ?? null,
      event.cipher_id ?? null
    );
  }

  insertEvents(events: Event[]): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO events (
        event_id, source_id, source_seq, device_id, project_id, session_id,
        event_ts, ingest_ts, source_kind, event_type, text_redacted,
        tool_name, tool_args_json, file_paths_json, meta_json, tags_json,
        redaction_manifest_json, cipher_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((events: Event[]) => {
      for (const event of events) {
        stmt.run(
          event.event_id,
          event.source_id,
          event.source_seq,
          event.device_id,
          event.project_id,
          event.session_id ?? null,
          event.event_ts,
          event.ingest_ts,
          event.source_kind,
          event.event_type,
          event.text_redacted,
          event.tool_name ?? null,
          event.tool_args_json ?? null,
          event.file_paths ? JSON.stringify(event.file_paths) : null,
          event.meta_json ?? null,
          event.tags ? JSON.stringify(event.tags) : null,
          event.redaction_manifest_json ?? null,
          event.cipher_id ?? null
        );
      }
    });

    insertMany(events);
  }

  getEvent(eventId: string): Event | undefined {
    const row = this.db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId) as any;
    return row ? this.rowToEvent(row) : undefined;
  }

  getEventCount(sourceId?: string): number {
    if (sourceId) {
      const row = this.db.prepare('SELECT COUNT(*) as count FROM events WHERE source_id = ?').get(sourceId) as { count: number };
      return row.count;
    }
    const row = this.db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number };
    return row.count;
  }

  private rowToEvent(row: any): Event {
    return {
      event_id: row.event_id,
      source_id: row.source_id,
      source_seq: row.source_seq,
      device_id: row.device_id,
      project_id: row.project_id,
      session_id: row.session_id,
      event_ts: row.event_ts,
      ingest_ts: row.ingest_ts,
      source_kind: row.source_kind,
      event_type: row.event_type,
      text_redacted: row.text_redacted,
      tool_name: row.tool_name,
      tool_args_json: row.tool_args_json,
      file_paths: row.file_paths_json ? JSON.parse(row.file_paths_json) : undefined,
      meta_json: row.meta_json,
      tags: row.tags_json ? JSON.parse(row.tags_json) : undefined,
      redaction_manifest_json: row.redaction_manifest_json,
      cipher_id: row.cipher_id,
    };
  }

  // ============================================================================
  // Search Operations
  // ============================================================================

  search(request: SearchRequest): SearchResponse {
    const start = performance.now();
    const sanitizedQuery = this.sanitizeFTSQuery(request.query);
    
    // Build WHERE clause for reuse in count and select
    let whereClause = 'WHERE events_fts MATCH ?';
    const filterParams: any[] = [];
    
    if (request.project_id) {
      // Resolve project identifier (display name, partial match, or full ID)
      const resolvedProjectId = this.resolveProjectId(request.project_id);
      
      // Support wildcards (* or %) in project_id
      if (request.project_id.includes('*') || request.project_id.includes('%')) {
        whereClause += ' AND e.project_id LIKE ?';
        filterParams.push(request.project_id.replace(/\*/g, '%'));
      } else if (resolvedProjectId) {
        whereClause += ' AND e.project_id = ?';
        filterParams.push(resolvedProjectId);
      } else {
        // No match found - use original (will return no results)
        whereClause += ' AND e.project_id = ?';
        filterParams.push(request.project_id);
      }
    }
    if (request.session_id) {
      // Support wildcards (* or %) in session_id
      if (request.session_id.includes('*') || request.session_id.includes('%')) {
        whereClause += ' AND e.session_id LIKE ?';
        filterParams.push(request.session_id.replace(/\*/g, '%'));
      } else {
        whereClause += ' AND e.session_id = ?';
        filterParams.push(request.session_id);
      }
    }
    if (request.event_types && request.event_types.length > 0) {
      whereClause += ` AND e.event_type IN (${request.event_types.map(() => '?').join(', ')})`;
      filterParams.push(...request.event_types);
    }
    if (request.role) {
      // Filter by message role: 'user' -> user_message, 'assistant' -> assistant_message
      const eventType = request.role === 'user' ? 'user_message' : 'assistant_message';
      whereClause += ' AND e.event_type = ?';
      filterParams.push(eventType);
    }
    if (request.tool_names && request.tool_names.length > 0) {
      // Support wildcards (* or %) in tool names
      const hasWildcard = request.tool_names.some(t => t.includes('*') || t.includes('%'));
      if (hasWildcard) {
        const likeConditions = request.tool_names.map(() => 'e.tool_name LIKE ?').join(' OR ');
        whereClause += ` AND (${likeConditions})`;
        filterParams.push(...request.tool_names.map(t => t.replace(/\*/g, '%')));
      } else {
        whereClause += ` AND e.tool_name IN (${request.tool_names.map(() => '?').join(', ')})`;
        filterParams.push(...request.tool_names);
      }
    }
    if (request.since) {
      whereClause += ' AND datetime(e.event_ts) >= datetime(?)';
      filterParams.push(request.since);
    }
    if (request.until) {
      whereClause += ' AND datetime(e.event_ts) <= datetime(?)';
      filterParams.push(request.until);
    }
    
    try {
      // Get total count first
      const countSql = `
        SELECT COUNT(*) as total
        FROM events e
        JOIN events_fts ON e.event_rowid = events_fts.rowid
        ${whereClause}
      `;
      const countRow = this.db.prepare(countSql).get(sanitizedQuery, ...filterParams) as { total: number };
      const total = countRow?.total ?? 0;
      
      // Get paginated results
      const limit = request.limit ?? 20;
      const offset = request.offset ?? 0;
      
      const sql = `
        SELECT 
          e.event_id,
          e.event_type,
          e.text_redacted,
          e.tool_name,
          e.tool_args_json,
          e.session_id,
          e.project_id,
          e.event_ts,
          e.cipher_id,
          bm25(events_fts) as score
        FROM events e
        JOIN events_fts ON e.event_rowid = events_fts.rowid
        ${whereClause}
        ORDER BY score
        LIMIT ? OFFSET ?
      `;
      
      const rows = this.db.prepare(sql).all(sanitizedQuery, ...filterParams, limit, offset) as any[];
      const searchMs = performance.now() - start;
      
      const results: SearchResult[] = rows.map(row => ({
        event_id: row.event_id,
        event_type: row.event_type,
        text_redacted: row.text_redacted,
        tool_name: row.tool_name,
        tool_args_json: row.tool_args_json,
        session_id: row.session_id,
        project_id: row.project_id,
        event_ts: row.event_ts,
        score: -row.score, // BM25 returns negative
        has_encrypted_original: row.cipher_id !== null,
      }));
      
      return {
        results,
        total,
        timing: {
          search_ms: searchMs,
          total_ms: searchMs,
        },
      };
    } catch (error: any) {
      console.warn(`FTS5 search failed: ${error.message}`);
      return {
        results: [],
        total: 0,
        timing: {
          search_ms: performance.now() - start,
          total_ms: performance.now() - start,
        },
      };
    }
  }

  private sanitizeFTSQuery(query: string): string {
    let sanitized = query;
    
    // Convert grep/regex style OR patterns to FTS5 OR
    // Handles: "a\|b\|c", "a|b|c", "(a|b|c)"
    sanitized = sanitized.replace(/\\\|/g, '|'); // unescape \|
    sanitized = sanitized.replace(/\(([^)]+)\)/g, '$1'); // remove parens
    
    // Split on | and convert to OR
    if (sanitized.includes('|')) {
      const orParts = sanitized.split('|').map(p => p.trim()).filter(p => p);
      sanitized = orParts.join(' OR ');
    }
    
    // Replace explicit AND (FTS5 uses spaces for implicit AND)
    sanitized = sanitized.replace(/\bAND\b/gi, ' ');
    
    // Remove forward slashes (often from paths in grep patterns)
    sanitized = sanitized.replace(/\//g, ' ');
    
    // Remove grep-style regex anchors and special chars
    sanitized = sanitized.replace(/[\^$.*+?{}[\]\\]/g, ' ');
    
    // Remove empty quotes and collapse whitespace
    sanitized = sanitized.replace(/""/g, '');
    sanitized = sanitized.replace(/\s+/g, ' ').trim();
    
    // Split on OR keyword, process each part
    const parts = sanitized.split(/\s+OR\s+/i);
    const escapedParts = parts.map(part => {
      const trimmed = part.trim();
      if (!trimmed) return null;
      
      // Already quoted - keep as-is
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed;
      }
      // Simple alphanumeric term - keep as-is
      if (/^[a-zA-Z0-9_]+$/.test(trimmed)) {
        return trimmed;
      }
      // Multiple words or special chars - quote it
      return `"${trimmed.replace(/"/g, '""')}"`;
    }).filter(Boolean);
    
    return escapedParts.join(' OR ');
  }

  // ============================================================================
  // Timeline Operations
  // ============================================================================

  timeline(request: TimelineRequest): TimelineResponse {
    // Build WHERE clause for reuse in count and select
    let whereClause = 'WHERE 1=1';
    const filterParams: any[] = [];
    
    if (request.since) {
      whereClause += ' AND datetime(event_ts) >= datetime(?)';
      filterParams.push(request.since);
    }
    if (request.until) {
      whereClause += ' AND datetime(event_ts) <= datetime(?)';
      filterParams.push(request.until);
    }
    if (request.project_id) {
      // Resolve project identifier (display name, partial match, or full ID)
      const resolvedProjectId = this.resolveProjectId(request.project_id);
      
      // Support wildcards (* or %) in project_id
      if (request.project_id.includes('*') || request.project_id.includes('%')) {
        whereClause += ' AND project_id LIKE ?';
        filterParams.push(request.project_id.replace(/\*/g, '%'));
      } else if (resolvedProjectId) {
        whereClause += ' AND project_id = ?';
        filterParams.push(resolvedProjectId);
      } else {
        // No match found - use original (will return no results)
        whereClause += ' AND project_id = ?';
        filterParams.push(request.project_id);
      }
    }
    if (request.session_id) {
      // Support wildcards (* or %) in session_id
      if (request.session_id.includes('*') || request.session_id.includes('%')) {
        whereClause += ' AND session_id LIKE ?';
        filterParams.push(request.session_id.replace(/\*/g, '%'));
      } else {
        whereClause += ' AND session_id = ?';
        filterParams.push(request.session_id);
      }
    }
    if (request.event_types && request.event_types.length > 0) {
      whereClause += ` AND event_type IN (${request.event_types.map(() => '?').join(', ')})`;
      filterParams.push(...request.event_types);
    }
    if (request.role) {
      // Filter by message role: 'user' -> user_message, 'assistant' -> assistant_message
      const eventType = request.role === 'user' ? 'user_message' : 'assistant_message';
      whereClause += ' AND event_type = ?';
      filterParams.push(eventType);
    }
    if (request.tool_names && request.tool_names.length > 0) {
      // Support wildcards (* or %) in tool names
      const hasWildcard = request.tool_names.some(t => t.includes('*') || t.includes('%'));
      if (hasWildcard) {
        const likeConditions = request.tool_names.map(() => 'tool_name LIKE ?').join(' OR ');
        whereClause += ` AND (${likeConditions})`;
        filterParams.push(...request.tool_names.map(t => t.replace(/\*/g, '%')));
      } else {
        whereClause += ` AND tool_name IN (${request.tool_names.map(() => '?').join(', ')})`;
        filterParams.push(...request.tool_names);
      }
    }
    if (request.include_git === false) {
      whereClause += ` AND event_type NOT IN ('git_commit', 'git_diff', 'git_branch', 'git_merge', 'git_stash', 'git_tag')`;
    }
    
    // Get total count first
    const countSql = `SELECT COUNT(*) as total FROM events ${whereClause}`;
    const countRow = this.db.prepare(countSql).get(...filterParams) as { total: number };
    const total = countRow?.total ?? 0;
    
    // Get paginated results
    const limit = request.limit ?? 100;
    const offset = request.offset ?? 0;
    
    const sql = `
      SELECT 
        event_id, event_type, event_ts, text_redacted,
        tool_name, tool_args_json, file_paths_json, meta_json, session_id, project_id, cipher_id
      FROM events
      ${whereClause}
      ORDER BY event_ts ASC
      LIMIT ? OFFSET ?
    `;
    
    const rows = this.db.prepare(sql).all(...filterParams, limit, offset) as any[];
    
    const events: TimelineEvent[] = rows.map(row => {
      const event: TimelineEvent = {
        event_id: row.event_id,
        event_type: row.event_type,
        event_ts: row.event_ts,
        text_redacted: row.text_redacted,
        session_id: row.session_id,
        project_id: row.project_id,
        has_encrypted_original: row.cipher_id !== null,
      };
      
      if (row.tool_name) {
        event.tool_name = row.tool_name;
      }
      
      if (row.tool_args_json) {
        event.tool_args_json = row.tool_args_json;
      }
      
      // Parse file_paths if present (for tool_call events)
      if (row.file_paths_json) {
        try {
          event.file_paths = JSON.parse(row.file_paths_json);
        } catch {}
      }
      
      // Parse git metadata if present
      if (row.meta_json && row.event_type.startsWith('git_')) {
        try {
          const meta = JSON.parse(row.meta_json);
          if (meta.sha) event.git_sha = meta.short_sha || meta.sha.slice(0, 7);
          if (meta.files_changed !== undefined) event.git_files_changed = meta.files_changed;
          if (meta.insertions !== undefined) event.git_insertions = meta.insertions;
          if (meta.deletions !== undefined) event.git_deletions = meta.deletions;
          if (meta.branch) event.git_branch = meta.branch;
          if (meta.to_branch) event.git_branch = meta.to_branch;
        } catch {}
      }
      
      return event;
    });
    
    // Build summary
    const byType: Record<string, number> = {};
    let commitsCount = 0;
    let linesAdded = 0;
    let linesRemoved = 0;
    
    for (const event of events) {
      byType[event.event_type] = (byType[event.event_type] || 0) + 1;
      if (event.event_type === 'git_commit') {
        commitsCount++;
        linesAdded += event.git_insertions || 0;
        linesRemoved += event.git_deletions || 0;
      }
    }
    
    return {
      events,
      total,
      summary: {
        total_events: events.length,
        by_type: byType,
        time_range: {
          since: request.since,
          until: request.until || new Date().toISOString(),
        },
        commits_count: commitsCount > 0 ? commitsCount : undefined,
        lines_added: linesAdded > 0 ? linesAdded : undefined,
        lines_removed: linesRemoved > 0 ? linesRemoved : undefined,
      },
    };
  }

  // ============================================================================
  // File View Operations
  // ============================================================================

  /**
   * Get file content from tool_result events for a given file path.
   * Returns events where the file was read/written, optionally filtered by time.
   */
  getFileEvents(filePath: string, options?: {
    since?: string;
    until?: string;
    toolNames?: string[];  // Filter by tool: Read, Write, Edit, etc.
    limit?: number;
  }): Array<{
    event_id: string;
    event_ts: string;
    tool_name: string;
    content: string;
    session_id?: string;
    project_id?: string;
  }> {
    let sql = `
      SELECT 
        event_id, event_ts, tool_name, text_redacted as content,
        session_id, project_id, tool_args_json
      FROM events
      WHERE event_type = 'tool_result'
        AND tool_name IN ('Read', 'read', 'Write', 'write', 'Edit', 'edit', 'Glob', 'Grep')
    `;
    
    const params: any[] = [];
    
    // Filter by file path in tool_args_json
    // Tool args have file_path, path, or filePath
    sql += ` AND (
      json_extract(tool_args_json, '$.file_path') = ?
      OR json_extract(tool_args_json, '$.path') = ?
      OR json_extract(tool_args_json, '$.filePath') = ?
    )`;
    params.push(filePath, filePath, filePath);
    
    if (options?.since) {
      sql += ' AND datetime(event_ts) >= datetime(?)';
      params.push(options.since);
    }
    if (options?.until) {
      sql += ' AND datetime(event_ts) <= datetime(?)';
      params.push(options.until);
    }
    if (options?.toolNames && options.toolNames.length > 0) {
      sql += ` AND tool_name IN (${options.toolNames.map(() => '?').join(', ')})`;
      params.push(...options.toolNames);
    }
    
    sql += ' ORDER BY event_ts DESC LIMIT ?';
    params.push(options?.limit ?? 10);
    
    const rows = this.db.prepare(sql).all(...params) as any[];
    
    return rows.map(row => ({
      event_id: row.event_id,
      event_ts: row.event_ts,
      tool_name: row.tool_name,
      content: row.content,
      session_id: row.session_id,
      project_id: row.project_id,
    }));
  }

  /**
   * Get the most recent content for a file path (from tool_result)
   * Includes both Read and Write tool results
   */
  getLatestFileContent(filePath: string, before?: string): {
    content: string;
    event_ts: string;
    tool_name: string;
    event_id: string;
  } | undefined {
    const params: any[] = [];
    
    // Match file path - check file_paths_json or paired tool_call args
    // Include both Read and Write tools to get full file content
    let sql = `
      SELECT 
        e.event_id, e.event_ts, e.tool_name, e.text_redacted as content
      FROM events e
      WHERE e.event_type = 'tool_result'
        AND e.tool_name IN ('Read', 'read', 'Write', 'write')
        AND (
          e.file_paths_json LIKE ?
          OR EXISTS (
            SELECT 1 FROM events tc 
            WHERE tc.event_type = 'tool_call'
            AND json_extract(e.meta_json, '$.tool_call_id') = json_extract(tc.meta_json, '$.tool_call_id')
            AND (
              json_extract(tc.tool_args_json, '$.file_path') = ?
              OR json_extract(tc.tool_args_json, '$.path') = ?
              OR json_extract(tc.tool_args_json, '$.filePath') = ?
            )
          )
        )
    `;
    params.push(`%${filePath}%`, filePath, filePath, filePath);
    
    if (before) {
      sql += ' AND datetime(e.event_ts) <= datetime(?)';
      params.push(before);
    }
    
    sql += ' ORDER BY e.event_ts DESC LIMIT 1';
    
    const row = this.db.prepare(sql).get(...params) as any;
    
    if (!row) return undefined;
    
    return {
      content: row.content,
      event_ts: row.event_ts,
      tool_name: row.tool_name,
      event_id: row.event_id,
    };
  }

  /**
   * Get all versions of a file (from Read/Write/Edit tool results)
   * Returns chronological history of file content snapshots
   */
  getFileHistory(filePath: string, options?: {
    since?: string;
    until?: string;
    limit?: number;
  }): Array<{
    event_id: string;
    event_ts: string;
    tool_name: string;
    content: string;
    line_count: number;
    session_id?: string;
    project_id?: string;
  }> {
    // We need to find tool_result events that are paired with tool_calls for this file
    // The file path is stored in the tool_call's args, linked via tool_call_id
    let sql = `
      SELECT 
        r.event_id,
        r.event_ts,
        r.tool_name,
        r.text_redacted as content,
        r.session_id,
        r.project_id,
        r.meta_json
      FROM events r
      WHERE r.event_type = 'tool_result'
        AND r.tool_name IN ('Read', 'read', 'Write', 'write')
        AND EXISTS (
          SELECT 1 FROM events c
          WHERE c.event_type = 'tool_call'
            AND c.tool_name = r.tool_name
            AND json_extract(c.meta_json, '$.tool_call_id') = json_extract(r.meta_json, '$.tool_call_id')
            AND (
              json_extract(c.tool_args_json, '$.file_path') = ?
              OR json_extract(c.tool_args_json, '$.filePath') = ?
              OR json_extract(c.tool_args_json, '$.path') = ?
            )
        )
    `;
    
    const params: any[] = [filePath, filePath, filePath];
    
    if (options?.since) {
      sql += ' AND datetime(r.event_ts) >= datetime(?)';
      params.push(options.since);
    }
    if (options?.until) {
      sql += ' AND datetime(r.event_ts) <= datetime(?)';
      params.push(options.until);
    }
    
    sql += ' ORDER BY r.event_ts ASC LIMIT ?';
    params.push(options?.limit ?? 50);
    
    const rows = this.db.prepare(sql).all(...params) as any[];
    
    return rows.map(row => ({
      event_id: row.event_id,
      event_ts: row.event_ts,
      tool_name: row.tool_name,
      content: row.content,
      line_count: row.content ? row.content.split('\n').length : 0,
      session_id: row.session_id,
      project_id: row.project_id,
    }));
  }

  /**
   * Get Edit tool calls with their diffs (oldString/newString)
   */
  getEdits(options?: {
    since?: string;
    until?: string;
    project_id?: string;
    session_id?: string;
    file_path?: string;
    limit?: number;
  }): Array<{
    event_id: string;
    event_ts: string;
    file_path: string;
    old_string: string;
    new_string: string;
    session_id?: string;
    project_id?: string;
  }> {
    let sql = `
      SELECT 
        event_id, event_ts, tool_args_json, session_id, project_id
      FROM events
      WHERE event_type = 'tool_call'
        AND tool_name IN ('Edit', 'edit')
        AND tool_args_json IS NOT NULL
    `;
    
    const params: any[] = [];
    
    if (options?.since) {
      sql += ' AND datetime(event_ts) >= datetime(?)';
      params.push(options.since);
    }
    if (options?.until) {
      sql += ' AND datetime(event_ts) <= datetime(?)';
      params.push(options.until);
    }
    if (options?.project_id) {
      sql += ' AND project_id = ?';
      params.push(options.project_id);
    }
    if (options?.session_id) {
      sql += ' AND session_id = ?';
      params.push(options.session_id);
    }
    if (options?.file_path) {
      sql += ` AND (
        json_extract(tool_args_json, '$.file_path') LIKE ?
        OR json_extract(tool_args_json, '$.path') LIKE ?
        OR json_extract(tool_args_json, '$.filePath') LIKE ?
      )`;
      const likePattern = `%${options.file_path}%`;
      params.push(likePattern, likePattern, likePattern);
    }
    
    sql += ' ORDER BY event_ts DESC LIMIT ?';
    params.push(options?.limit ?? 20);
    
    const rows = this.db.prepare(sql).all(...params) as any[];
    
    return rows.map(row => {
      let args: any = {};
      try {
        args = JSON.parse(row.tool_args_json);
      } catch {}
      
      return {
        event_id: row.event_id,
        event_ts: row.event_ts,
        file_path: args.filePath || args.file_path || args.path || 'unknown',
        old_string: args.oldString || args.old_string || '',
        new_string: args.newString || args.new_string || '',
        session_id: row.session_id,
        project_id: row.project_id,
      };
    });
  }

  /**
   * Find the most recent Read tool result for a file
   */
  findReadResult(filePath: string, before?: string): { event_ts: string; content: string } | null {
    const sql = `
      SELECT 
        e1.event_ts,
        e2.text_redacted as content
      FROM events e1
      LEFT JOIN events e2 
        ON e2.event_type = 'tool_result' 
        AND e2.tool_name = 'Read'
        AND ABS(CAST((julianday(e2.event_ts) - julianday(e1.event_ts)) * 86400 AS INTEGER)) < 5
      WHERE e1.event_type = 'tool_call'
        AND e1.tool_name = 'Read'
        AND json_extract(e1.tool_args_json, '$.filePath') LIKE ?
        ${before ? 'AND datetime(e1.event_ts) <= datetime(?)' : ''}
      ORDER BY e1.event_ts DESC
      LIMIT 1
    `;
    
    const params = [`%${filePath}%`];
    if (before) params.push(before);
    
    const row = this.db.prepare(sql).get(...params) as any;
    
    // Only return if content is substantial and not truncated
    // Check if it ends with a proper closing brace/bracket (not mid-line truncation)
    if (row && row.content && row.content.length > 1000) {
      const content = row.content;
      const lastChars = content.slice(-10).trim();
      
      // Skip if it looks truncated (doesn't end with }, ), `, or newline)
      if (!lastChars.match(/[}\)\`\n]$/)) {
        return null; // Likely truncated, fall back to Edit reconstruction
      }
      
      return {
        event_ts: row.event_ts,
        content: row.content,
      };
    }
    
    return null;
  }

  /**
   * List files that have been accessed (from tool_call events)
   */
  listAccessedFiles(options?: {
    since?: string;
    until?: string;
    project_id?: string;
    pattern?: string;  // Glob pattern like *.ts
    limit?: number;
  }): Array<{
    file_path: string;
    last_accessed: string;
    access_count: number;
    tools_used: string[];
  }> {
    // Get file paths from tool_call events
    let sql = `
      SELECT 
        COALESCE(
          json_extract(tool_args_json, '$.file_path'),
          json_extract(tool_args_json, '$.path'),
          json_extract(tool_args_json, '$.filePath')
        ) as file_path,
        MAX(event_ts) as last_accessed,
        COUNT(*) as access_count,
        GROUP_CONCAT(DISTINCT tool_name) as tools_used
      FROM events
      WHERE event_type = 'tool_call'
        AND tool_name IN ('Read', 'read', 'Write', 'write', 'Edit', 'edit')
        AND (
          json_extract(tool_args_json, '$.file_path') IS NOT NULL
          OR json_extract(tool_args_json, '$.path') IS NOT NULL
          OR json_extract(tool_args_json, '$.filePath') IS NOT NULL
        )
    `;
    
    const params: any[] = [];
    
    if (options?.since) {
      sql += ' AND datetime(event_ts) >= datetime(?)';
      params.push(options.since);
    }
    if (options?.until) {
      sql += ' AND datetime(event_ts) <= datetime(?)';
      params.push(options.until);
    }
    if (options?.project_id) {
      sql += ' AND project_id = ?';
      params.push(options.project_id);
    }
    if (options?.pattern) {
      // Convert glob to SQL LIKE pattern
      const likePattern = options.pattern
        .replace(/\*/g, '%')
        .replace(/\?/g, '_');
      sql += ` AND (
        json_extract(tool_args_json, '$.file_path') LIKE ?
        OR json_extract(tool_args_json, '$.path') LIKE ?
        OR json_extract(tool_args_json, '$.filePath') LIKE ?
      )`;
      params.push(likePattern, likePattern, likePattern);
    }
    
    sql += ' GROUP BY file_path ORDER BY last_accessed DESC LIMIT ?';
    params.push(options?.limit ?? 50);
    
    const rows = this.db.prepare(sql).all(...params) as any[];
    
    return rows.map(row => ({
      file_path: row.file_path,
      last_accessed: row.last_accessed,
      access_count: row.access_count,
      tools_used: row.tools_used ? row.tools_used.split(',') : [],
    }));
  }

  // ============================================================================
  // Stats
  // ============================================================================

  // Cost per million tokens (USD) - updated Jan 2026
  // https://docs.anthropic.com/en/docs/about-claude/pricing
  // Cache read = 0.1× input, Cache write (5min) = 1.25× input
  private static readonly MODEL_PRICING: Record<string, { input: number; output: number; cache_read: number; cache_write: number }> = {
    // Anthropic (from official pricing page)
    'claude-opus-4-5': { input: 5, output: 25, cache_read: 0.50, cache_write: 6.25 },
    'claude-opus-4-1': { input: 15, output: 75, cache_read: 1.50, cache_write: 18.75 },
    'claude-opus-4': { input: 15, output: 75, cache_read: 1.50, cache_write: 18.75 },
    'claude-sonnet-4-5': { input: 3, output: 15, cache_read: 0.30, cache_write: 3.75 },
    'claude-sonnet-4-5-20250929': { input: 3, output: 15, cache_read: 0.30, cache_write: 3.75 },
    'claude-sonnet-4': { input: 3, output: 15, cache_read: 0.30, cache_write: 3.75 },
    'claude-sonnet-3-7': { input: 3, output: 15, cache_read: 0.30, cache_write: 3.75 },
    'claude-haiku-4-5': { input: 1, output: 5, cache_read: 0.10, cache_write: 1.25 },
    'claude-haiku-3-5': { input: 0.80, output: 4, cache_read: 0.08, cache_write: 1 },
    'claude-3-5-sonnet': { input: 3, output: 15, cache_read: 0.30, cache_write: 3.75 },
    'claude-3-5-sonnet-20241022': { input: 3, output: 15, cache_read: 0.30, cache_write: 3.75 },
    'claude-3-5-haiku': { input: 0.80, output: 4, cache_read: 0.08, cache_write: 1 },
    'claude-3-opus': { input: 15, output: 75, cache_read: 1.50, cache_write: 18.75 },
    'claude-3-sonnet': { input: 3, output: 15, cache_read: 0.30, cache_write: 3.75 },
    'claude-3-haiku': { input: 0.25, output: 1.25, cache_read: 0.03, cache_write: 0.30 },
    // OpenAI (estimated - cache pricing varies)
    'gpt-4o': { input: 2.50, output: 10, cache_read: 1.25, cache_write: 2.50 },
    'gpt-4o-mini': { input: 0.15, output: 0.60, cache_read: 0.075, cache_write: 0.15 },
    'gpt-4-turbo': { input: 10, output: 30, cache_read: 5, cache_write: 10 },
    'gpt-4': { input: 30, output: 60, cache_read: 15, cache_write: 30 },
    'gpt-3.5-turbo': { input: 0.50, output: 1.50, cache_read: 0.25, cache_write: 0.50 },
    'gpt-5': { input: 5, output: 20, cache_read: 2.50, cache_write: 5 },
    'gpt-5.2': { input: 5, output: 20, cache_read: 2.50, cache_write: 5 },
    'o1': { input: 15, output: 60, cache_read: 7.50, cache_write: 15 },
    'o1-mini': { input: 3, output: 12, cache_read: 1.50, cache_write: 3 },
    'o1-preview': { input: 15, output: 60, cache_read: 7.50, cache_write: 15 },
    'o3-mini': { input: 1.10, output: 4.40, cache_read: 0.55, cache_write: 1.10 },
    // Other providers (estimated)
    'minimax': { input: 0.50, output: 2, cache_read: 0.25, cache_write: 0.50 },
    'glm': { input: 0.50, output: 2, cache_read: 0.25, cache_write: 0.50 },
    // Default fallback (use sonnet pricing as conservative default)
    'unknown': { input: 3, output: 15, cache_read: 0.30, cache_write: 3.75 },
  };

  private calculateCost(
    tokens: { input: number; output: number; cache_read: number; cache_write: number },
    model: string
  ): number {
    const pricing = RecallDB.MODEL_PRICING;
    
    // Normalize model name: lowercase, replace dots with dashes
    const normalizeModel = (m: string) => m.toLowerCase().replace(/\./g, '-').replace(/_/g, '-');
    const normalizedModel = normalizeModel(model);
    
    // Direct match first
    let modelPricing = pricing[model] || pricing[normalizedModel];
    
    if (!modelPricing) {
      // Try matching normalized keys
      for (const [key, value] of Object.entries(pricing)) {
        const normalizedKey = normalizeModel(key);
        if (normalizedModel.includes(normalizedKey) || normalizedKey.includes(normalizedModel)) {
          modelPricing = value;
          break;
        }
      }
    }
    
    // Fallback to provider-based matching (e.g., "minimax-m2.1" -> "minimax")
    if (!modelPricing) {
      if (normalizedModel.includes('minimax')) modelPricing = pricing['minimax'];
      else if (normalizedModel.includes('glm')) modelPricing = pricing['glm'];
      else if (normalizedModel.includes('claude')) modelPricing = pricing['claude-sonnet-4']; // default claude
      else if (normalizedModel.includes('gpt')) modelPricing = pricing['gpt-4o']; // default openai
    }
    
    if (!modelPricing) modelPricing = pricing['unknown'];

    const cost =
      (tokens.input * modelPricing.input / 1_000_000) +
      (tokens.output * modelPricing.output / 1_000_000) +
      (tokens.cache_read * modelPricing.cache_read / 1_000_000) +
      (tokens.cache_write * modelPricing.cache_write / 1_000_000);

    // Do not round here; rounding happens after aggregation.
    return cost;
  }

  stats(): {
    eventCount: number;
    sourceCount: number;
    projectCount: number;
    deviceCount: number;
  } {
    const eventCount = (this.db.prepare('SELECT COUNT(*) as c FROM events').get() as any).c;
    const sourceCount = (this.db.prepare('SELECT COUNT(*) as c FROM sources').get() as any).c;
    const projectCount = (this.db.prepare('SELECT COUNT(*) as c FROM projects').get() as any).c;
    const deviceCount = (this.db.prepare('SELECT COUNT(*) as c FROM devices').get() as any).c;
    
    return { eventCount, sourceCount, projectCount, deviceCount };
  }

  /**
   * Get token usage statistics from meta_json with cost calculation
   */
  getTokenStats(options?: {
    since?: string;
    until?: string;
    project_id?: string;
    session_id?: string;
    group_by?: 'day' | 'session' | 'model';
  }): {
    total: { input: number; output: number; cache_read: number; cache_write: number; cost_usd: number };
    by_day?: Record<string, { input: number; output: number; cache_read: number; cache_write: number; cost_usd: number }>;
    by_session?: Record<string, { input: number; output: number; cache_read: number; cache_write: number; cost_usd: number; model?: string }>;
    by_model?: Record<string, { input: number; output: number; cache_read: number; cache_write: number; cost_usd: number }>;
  } {
    // Build WHERE clause
    // NOTE: OpenCode token data is message-level and may live on a tool_call or assistant_message event.
    // We query all events with meta_json, then:
    // - For non-OpenCode sources: keep historical behavior (assistant_message only)
    // - For OpenCode sources: de-dupe by message_id so tokens counted once per message
    let whereClause = 'WHERE meta_json IS NOT NULL';
    const params: any[] = [];

    if (options?.since) {
      whereClause += ' AND datetime(event_ts) >= datetime(?)';
      params.push(options.since);
    }
    if (options?.until) {
      whereClause += ' AND datetime(event_ts) <= datetime(?)';
      params.push(options.until);
    }
    if (options?.project_id) {
      whereClause += ' AND project_id = ?';
      params.push(options.project_id);
    }
    if (options?.session_id) {
      whereClause += ' AND session_id = ?';
      params.push(options.session_id);
    }

    // Query for events with token data
    const sql = `
      SELECT 
        event_id,
        source_id,
        source_kind,
        event_type,
        event_ts,
        session_id,
        project_id,
        meta_json
      FROM events
      ${whereClause}
      ORDER BY event_ts ASC
    `;

    const rows = this.db.prepare(sql).all(...params) as any[];

    // Aggregate tokens
    const total = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0 };
    const by_day: Record<string, { input: number; output: number; cache_read: number; cache_write: number; cost_usd: number }> = {};
    const by_session: Record<string, { input: number; output: number; cache_read: number; cache_write: number; cost_usd: number; model?: string }> = {};
    const by_model: Record<string, { input: number; output: number; cache_read: number; cache_write: number; cost_usd: number }> = {};

    const seenOpenCodeMessages = new Set<string>();

    for (const row of rows) {
      // Preserve previous behavior for non-OpenCode sources
      if (row.source_kind !== 'opencode_storage' && row.event_type !== 'assistant_message') {
        continue;
      }

      let meta: any;
      try {
        meta = JSON.parse(row.meta_json);
      } catch {
        continue;
      }

      const tokens = meta.tokens;
      if (!tokens) continue;

      // OpenCode: count tokens once per message
      if (row.source_kind === 'opencode_storage') {
        const messageId = meta.message_id;
        const dedupeKey = `${row.source_id}:${messageId || row.event_id}`;
        if (seenOpenCodeMessages.has(dedupeKey)) {
          continue;
        }
        seenOpenCodeMessages.add(dedupeKey);
      }

      const input = tokens.input || 0;
      const output = tokens.output || 0;
      const cache_read = tokens.cache_read || 0;
      const cache_write = tokens.cache_write || 0;
      const model = meta.model || 'unknown';

      // For now, only Anthropic/Claude pricing is considered reliable.
      // Skip token+cost aggregation for other models to avoid misleading totals.
      const normalizedModel = String(model).toLowerCase();
      const isPricedModel = normalizedModel.includes('claude');
      if (!isPricedModel) {
        continue;
      }

      // Calculate cost for this event/message
      const eventCost = this.calculateCost({ input, output, cache_read, cache_write }, model);

      // Total
      total.input += input;
      total.output += output;
      total.cache_read += cache_read;
      total.cache_write += cache_write;
      total.cost_usd += eventCost;

      // By day
      const day = row.event_ts.split('T')[0];
      if (!by_day[day]) by_day[day] = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0 };
      by_day[day].input += input;
      by_day[day].output += output;
      by_day[day].cache_read += cache_read;
      by_day[day].cache_write += cache_write;
      by_day[day].cost_usd += eventCost;

      // By session
      if (row.session_id) {
        if (!by_session[row.session_id]) {
          by_session[row.session_id] = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0 };
        }
        by_session[row.session_id].input += input;
        by_session[row.session_id].output += output;
        by_session[row.session_id].cache_read += cache_read;
        by_session[row.session_id].cache_write += cache_write;
        by_session[row.session_id].cost_usd += eventCost;
        if (meta.model) by_session[row.session_id].model = meta.model;
      }

      // By model
      if (!by_model[model]) by_model[model] = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0 };
      by_model[model].input += input;
      by_model[model].output += output;
      by_model[model].cache_read += cache_read;
      by_model[model].cache_write += cache_write;
      by_model[model].cost_usd += eventCost;
    }
    
    // Round total cost
    total.cost_usd = Math.round(total.cost_usd * 100) / 100;
    
    // Round all costs
    for (const day of Object.keys(by_day)) {
      by_day[day].cost_usd = Math.round(by_day[day].cost_usd * 100) / 100;
    }
    for (const session of Object.keys(by_session)) {
      by_session[session].cost_usd = Math.round(by_session[session].cost_usd * 100) / 100;
    }
    for (const model of Object.keys(by_model)) {
      by_model[model].cost_usd = Math.round(by_model[model].cost_usd * 100) / 100;
    }
    
    const result: any = { total };
    
    if (options?.group_by === 'day' || !options?.group_by) {
      result.by_day = by_day;
    }
    if (options?.group_by === 'session') {
      result.by_session = by_session;
    }
    if (options?.group_by === 'model') {
      result.by_model = by_model;
    }
    
    return result;
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  close() {
    this.db.close();
  }
}
