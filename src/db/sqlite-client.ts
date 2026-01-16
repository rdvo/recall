import Database from 'better-sqlite3';
import type { Document, SearchResult } from '../types.js';
import type { DatabaseClient } from './types.js';

export class SQLiteClient implements DatabaseClient {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath: string = './store/recall.sqlite') {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.initialize();
  }

  initialize() {
    // Create documents table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        content,
        content='documents',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
      END;

      CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON documents BEGIN
        DELETE FROM documents_fts WHERE rowid = OLD.rowid;
      END;

      CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON documents BEGIN
        DELETE FROM documents_fts WHERE rowid = OLD.rowid;
        INSERT INTO documents_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
      END;
    `);
  }

  index(doc: Document) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO documents (id, content, metadata, created_at)
      VALUES (?, ?, ?, ?)
    `);
    
    stmt.run(
      doc.id,
      doc.content,
      doc.metadata ? JSON.stringify(doc.metadata) : null,
      doc.created_at || new Date().toISOString()
    );
  }

  indexMany(docs: Document[]) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO documents (id, content, metadata, created_at)
      VALUES (?, ?, ?, ?)
    `);
    
    const insertMany = this.db.transaction((docs: Document[]) => {
      for (const doc of docs) {
        stmt.run(
          doc.id,
          doc.content,
          doc.metadata ? JSON.stringify(doc.metadata) : null,
          doc.created_at || new Date().toISOString()
        );
      }
    });
    
    insertMany(docs);
  }

  private sanitizeFTS5Query(query: string): string {
    // Replace explicit AND (FTS5 uses spaces for implicit AND)
    let sanitized = query.replace(/\bAND\b/gi, ' ');

    // Unescape wildcards that may have been escaped upstream
    sanitized = sanitized.replace(/\\\*/g, '*');

    // Remove forward slashes (they break FTS5 in quoted terms)
    sanitized = sanitized.replace(/\//g, ' ');

    // Remove empty quotes and collapse whitespace
    sanitized = sanitized.replace(/""/g, '');
    sanitized = sanitized.replace(/\s+/g, ' ').trim();

    return sanitized;
  }

  async search(query: string, limit: number = 20): Promise<SearchResult[]> {
    const sanitizedQuery = this.sanitizeFTS5Query(query);
    // FTS5 query sanitization
    // FTS5 special chars that need escaping: ", [, ], ?, *, ^, \
    // Also need to handle terms that might be interpreted as operators
    
    // Split query by OR to handle each part separately
    const parts = sanitizedQuery.split(/\s+OR\s+/i);
    const sanitizedParts = parts.map(part => {
      const trimmed = part.trim();
      
      // If it's a quoted phrase, escape internal quotes
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        const inner = trimmed.slice(1, -1);
        return `"${inner.replace(/"/g, '""')}"`;
      }
      
      // For unquoted terms, escape special chars and wrap in quotes if needed
      // FTS5 can handle simple terms, but complex ones need quotes
      const escaped = trimmed
        .replace(/\\/g, '\\\\')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\?/g, '\\?')
        .replace(/\^/g, '\\^');
      
      // If term has spaces or special chars, quote it
      if (escaped.includes(' ') || /[\[\]?*^\\]/.test(escaped)) {
        return `"${escaped}"`;
      }
      
      return escaped;
    });
    
    const escapedQuery = sanitizedParts.join(' OR ');
    
    const stmt = this.db.prepare(`
      SELECT 
        d.id,
        d.content,
        d.metadata,
        d.created_at,
        bm25(documents_fts) as score
      FROM documents d
      JOIN documents_fts ON d.rowid = documents_fts.rowid
      WHERE documents_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `);
    
    try {
      const rows = stmt.all(escapedQuery, limit) as any[];
      return rows.map(row => ({
        id: row.id,
        content: row.content,
        metadata: row.metadata ? JSON.parse(row.metadata) : {},
        score: -row.score, // BM25 returns negative, flip for descending
        created_at: row.created_at
      }));
    } catch (error: any) {
      // If FTS5 fails, try simpler query with just the first few terms
      console.warn(`FTS5 query failed: ${error.message}, query: ${escapedQuery}`);
      const simpleTerms = query.split(/\s+OR\s+/i).slice(0, 5).join(' OR ');
      const rows = stmt.all(simpleTerms, limit) as any[];
      return rows.map(row => ({
        id: row.id,
        content: row.content,
        metadata: row.metadata ? JSON.parse(row.metadata) : {},
        score: -row.score,
        created_at: row.created_at
      }));
    }
  }

  async searchWithRegex(pattern: string, limit: number = 20): Promise<SearchResult[]> {
    // SQLite doesn't have native regex, use LIKE for simple patterns
    // For complex regex, we'd need to filter in JS
    const stmt = this.db.prepare(`
      SELECT 
        id,
        content,
        metadata,
        created_at,
        1.0 as score
      FROM documents
      WHERE content LIKE ?
      LIMIT ?
    `);
    
    // Convert regex to LIKE pattern (basic)
    const likePattern = pattern
      .replace(/\.\*/g, '%')
      .replace(/\./g, '_')
      .replace(/\?/g, '_');
    
    const rows = stmt.all(`%${likePattern}%`, limit) as any[];
    
    return rows.map(row => ({
      id: row.id,
      content: row.content,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      score: row.score,
      created_at: row.created_at
    }));
  }

  delete(id: string) {
    const stmt = this.db.prepare('DELETE FROM documents WHERE id = ?');
    stmt.run(id);
  }

  deleteAll() {
    this.db.exec(`
      DELETE FROM documents;
      DELETE FROM documents_fts;
    `);
  }

  stats() {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM documents');
    const row = stmt.get() as { count: number };
    return {
      documentCount: row.count
    };
  }

  close() {
    this.db.close();
  }
}

