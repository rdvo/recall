/**
 * Recall v2: Main Service
 * 
 * Orchestrates ingestion, search, and timeline operations.
 */

import { randomUUID } from 'crypto';
import { existsSync, statSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import chokidar from 'chokidar';
import { RecallDB } from './db/client.js';
import { getDeviceIdentity, detectProject, extractClaudeProjectHash } from './identity.js';
import { 
  discoverClaudeCodeFiles,
  discoverClaudeCodeWorkingDirs,
  ingestClaudeCodeFile,
  type IngestResult 
} from './ingest/claude-code.js';
import {
  isGitRepo,
  ingestGitRepo,
  type GitIngestResult,
} from './ingest/git.js';
import {
  hasOpenCodeStorage,
  discoverOpenCodeWorkingDirs,
  getOpenCodeSessionSources,
  discoverOpenCodeSessions,
  ingestOpenCodeSession,
  type OpenCodeCursor,
  type OpenCodeIngestResult,
  OPENCODE_STORAGE_DIR,
} from './ingest/opencode.js';
import type { 
  Source, 
  Cursor, 
  Project,
  SearchRequest, 
  SearchResponse,
  TimelineRequest,
  TimelineResponse,
  SourceKind,
} from './types.js';


// ============================================================================
// Configuration
// ============================================================================

export interface RecallConfig {
  dbPath?: string;
  autoDiscover?: boolean;  // auto-discover Claude Code files
}

const DEFAULT_CONFIG: Required<RecallConfig> = {
  dbPath: join(homedir(), '.local', 'share', 'recall', 'recall.sqlite'),
  autoDiscover: true,
};

// ============================================================================
// Recall Service
// ============================================================================

export class RecallService {
  private db: RecallDB;
  private config: Required<RecallConfig>;
  private deviceId: string;
  private deviceNickname: string;
  private watchers: Map<string, ReturnType<typeof chokidar.watch>> = new Map();
  private rediscoverInterval?: NodeJS.Timeout;
  private running = false;

  constructor(config: RecallConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Ensure db directory exists
    const dbDir = dirname(this.config.dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    
    this.db = new RecallDB(this.config.dbPath);
    
    // Initialize device identity
    const device = getDeviceIdentity();
    this.deviceId = device.device_id;
    this.deviceNickname = device.nickname;
    
    // Register device in DB
    this.db.getOrCreateDevice(this.deviceId, this.deviceNickname);
  }

  // ============================================================================
  // Source Management
  // ============================================================================

  /**
   * Add Claude Code as a source (auto-discovers all JSONL files + git repos)
   */
  async addClaudeCodeSource(): Promise<{ claudeSources: Source[]; gitSources: Source[]; workingDirs: string[] }> {
    const files = discoverClaudeCodeFiles();
    const claudeSources: Source[] = [];
    
    // Add Claude Code JSONL sources
    for (const filePath of files) {
      const source = this.registerSource(filePath, 'claude_code_jsonl');
      claudeSources.push(source);
    }
    
    // Auto-discover git repos from Claude Code working directories
    const workingDirs = discoverClaudeCodeWorkingDirs();
    const gitSources: Source[] = [];
    
    for (const dir of workingDirs) {
      if (isGitRepo(dir)) {
        // Check if already registered
        const existing = this.db.getSourceByLocator(dir, this.deviceId);
        if (!existing) {
          try {
            const source = this.addGitSource(dir);
            gitSources.push(source);
          } catch (e) {
            console.warn(`Failed to add git source for ${dir}: ${e}`);
          }
        }
      }
    }
    
    return { claudeSources, gitSources, workingDirs };
  }

  /**
   * Add OpenCode as a source (auto-discovers all sessions + git repos)
   */
  async addOpenCodeSource(): Promise<{ sessionSources: Source[]; gitSources: Source[]; workingDirs: string[] }> {
    if (!hasOpenCodeStorage()) {
      return { sessionSources: [], gitSources: [], workingDirs: [] };
    }
    
    const sessionInfos = getOpenCodeSessionSources();
    const sessionSources: Source[] = [];
    
    // Add each OpenCode session as a source
    for (const info of sessionInfos) {
      const source = this.registerSource(info.locator, 'opencode_storage');
      sessionSources.push(source);
    }
    
    // Auto-discover git repos from OpenCode working directories
    const workingDirs = discoverOpenCodeWorkingDirs();
    const gitSources: Source[] = [];
    
    for (const dir of workingDirs) {
      if (isGitRepo(dir)) {
        // Check if already registered
        const existing = this.db.getSourceByLocator(dir, this.deviceId);
        if (!existing) {
          try {
            const source = this.addGitSource(dir);
            gitSources.push(source);
          } catch (e) {
            console.warn(`Failed to add git source for ${dir}: ${e}`);
          }
        }
      }
    }
    
    return { sessionSources, gitSources, workingDirs };
  }

  /**
   * Add Cursor as a source (auto-discovers agent transcripts + git repos)
   * AGENT MODE ONLY - no more SQLite chat bullshit!
   */
  async addCursorSource(): Promise<{
    transcriptSources: Source[];
    gitSources: Source[];
    workingDirs: string[];
  }> {
    const transcriptSources: Source[] = [];
    const gitSources: Source[] = [];

    const { discoverCursorTranscripts, discoverCursorWorkingDirs } = await import('./ingest/cursor.js');

    // Discover and add transcript sources (AGENT MODE ONLY)
    const transcripts = discoverCursorTranscripts();
    for (const transcript of transcripts) {
      const locator = `cursor-transcript://${transcript.id}`;
      const source = this.registerSource(locator, 'cursor_transcript');
      transcriptSources.push(source);
    }

    // Auto-discover git repos from Cursor working directories
    const workingDirs = discoverCursorWorkingDirs();
    for (const dir of workingDirs) {
      if (isGitRepo(dir)) {
        const existing = this.db.getSourceByLocator(dir, this.deviceId);
        if (!existing) {
          try {
            const source = this.addGitSource(dir);
            gitSources.push(source);
          } catch (e) {
            console.warn(`Failed to add git source for ${dir}: ${e}`);
          }
        }
      }
    }

    return { transcriptSources, gitSources, workingDirs };
  }

  /**
   * Add git repository as a source
   */
  addGitSource(dir: string = process.cwd()): Source {
    if (!isGitRepo(dir)) {
      throw new Error(`Not a git repository: ${dir}`);
    }
    
    const projectInfo = detectProject(dir);
    
    // Register project
    const project = this.db.getOrCreateProject({
      ...projectInfo,
      share_policy: 'private',
    });
    
    // Register source with git root as locator
    const source = this.registerSource(project.root_path, 'git', project.project_id);
    
    return source;
  }

  /**
   * Register a source file
   */
  registerSource(locator: string, kind: SourceKind, projectId?: string): Source {
    // Check if already registered
    const existing = this.db.getSourceByLocator(locator, this.deviceId);
    if (existing) {
      return existing;
    }
    
    // Detect project from file path if not provided
    if (!projectId && kind === 'claude_code_jsonl') {
      // For Claude Code, try to find the working directory from the project hash
      // The project hash in the path maps to a directory
      const projectHash = extractClaudeProjectHash(locator);
      if (projectHash) {
        // We'll create a placeholder project for now
        // In practice, we'd want to resolve this to actual directory
        const project = this.db.getOrCreateProject({
          project_id: `claude-${projectHash}`,
          display_name: `Claude Project ${projectHash.slice(0, 8)}`,
          root_path: dirname(locator),
          share_policy: 'private',
        });
        projectId = project.project_id;
      }
    }
    
    const source = this.db.createSource({
      source_id: randomUUID(),
      kind,
      locator,
      device_id: this.deviceId,
      status: 'active',
      retain_on_delete: true,
      redact_secrets: true,
      encrypt_originals: false,
    });
    
    return source;
  }

  /**
   * List all sources
   */
  listSources(): Source[] {
    return this.db.listSources(this.deviceId);
  }

  listProjects(): Project[] {
    return this.db.listProjects();
  }

  getProjectsStatus() {
    return this.db.getProjectsStatus();
  }

  removeSource(sourceId: string, purgeEvents: boolean = false): void {
    this.stopWatching(sourceId);
    this.db.deleteSource(sourceId, purgeEvents);
  }

  // ============================================================================
  // Ingestion
  // ============================================================================

  /**
   * Ingest all pending events from all sources
   */
  async ingestAll(): Promise<IngestResult[]> {
    const sources = this.db.listSources(this.deviceId);
    const results: IngestResult[] = [];
    
    for (const source of sources) {
      if (source.status !== 'active') continue;
      
      try {
        const result = await this.ingestSource(source);
        results.push(result);
      } catch (e) {
        console.error(`Failed to ingest ${source.locator}: ${e}`);
        this.db.updateSourceStatus(source.source_id, 'error', String(e));
      }
    }
    
    return results;
  }

  /**
   * Ingest from a single source
   */
  async ingestSource(source: Source): Promise<IngestResult> {
    if (source.kind === 'claude_code_jsonl') {
      return this.ingestClaudeCode(source);
    }
    
    if (source.kind === 'opencode_storage') {
      return this.ingestOpenCode(source);
    }

    if (source.kind === 'cursor_transcript') {
      return this.ingestCursorTranscript(source);
    }
    
    if (source.kind === 'git') {
      return this.ingestGit(source);
    }
    
    throw new Error(`Unsupported source kind: ${source.kind}`);
  }

  /**
   * Ingest from Claude Code JSONL
   */
  private async ingestClaudeCode(source: Source): Promise<IngestResult> {
    // Check if file exists
    if (!existsSync(source.locator)) {
      this.db.updateSourceStatus(source.source_id, 'missing');
      return {
        sourceId: source.source_id,
        filePath: source.locator,
        linesProcessed: 0,
        eventsCreated: 0,
        errors: ['File not found'],
      };
    }
    
    // Get cursor
    const cursor = this.db.getCursor(source.source_id);
    
    // Detect project
    const projectHash = extractClaudeProjectHash(source.locator);
    const projectId = projectHash ? `claude-${projectHash}` : null;
    
    // Ingest
    const { events, newCursor, result } = ingestClaudeCodeFile(
      source.locator,
      cursor,
      {
        sourceId: source.source_id,
        deviceId: this.deviceId,
        projectId,
        sourceKind: 'claude_code_jsonl',
        redactSecrets: source.redact_secrets,
      }
    );
    
    // Store events
    if (events.length > 0) {
      this.db.insertEvents(events);
    }
    
    // Update cursor
    this.db.upsertCursor(newCursor);
    
    // Update source status
    this.db.updateSourceStatus(source.source_id, 'active');
    
    return result;
  }

  /**
   * Ingest from OpenCode storage
   */
  private async ingestOpenCode(source: Source): Promise<IngestResult> {
    // Extract session ID from locator (format: opencode://{session-id})
    const sessionIdMatch = source.locator.match(/^opencode:\/\/(.+)$/);
    if (!sessionIdMatch) {
      return {
        sourceId: source.source_id,
        filePath: source.locator,
        linesProcessed: 0,
        eventsCreated: 0,
        errors: ['Invalid OpenCode locator format'],
      };
    }
    
    const sessionId = sessionIdMatch[1];
    
    // Find the session
    const sessions = discoverOpenCodeSessions();
    const session = sessions.find(s => s.id === sessionId);
    
    if (!session) {
      this.db.updateSourceStatus(source.source_id, 'missing');
      return {
        sourceId: source.source_id,
        filePath: source.locator,
        linesProcessed: 0,
        eventsCreated: 0,
        errors: ['Session not found'],
      };
    }
    
    // Get cursor
    const cursor = this.db.getCursor(source.source_id) as OpenCodeCursor | undefined;
    
    // Detect project from session's working directory
    const projectInfo = session.directory ? detectProject(session.directory) : null;
    const projectId = projectInfo?.project_id ?? null;
    
    // Ensure project exists
    if (projectInfo) {
      this.db.getOrCreateProject({
        ...projectInfo,
        share_policy: 'private',
      });
    }
    
    // Ingest
    const { events, newCursor, result } = ingestOpenCodeSession(
      session,
      cursor,
      {
        sourceId: source.source_id,
        deviceId: this.deviceId,
        projectId,
        sourceKind: 'opencode_storage',
        redactSecrets: source.redact_secrets,
      }
    );
    
    // Store events
    if (events.length > 0) {
      this.db.insertEvents(events);
    }
    
    // Update cursor
    this.db.upsertCursor(newCursor);
    
    // Update source status
    this.db.updateSourceStatus(source.source_id, 'active');
    
    // Convert OpenCodeIngestResult to IngestResult
    return {
      sourceId: result.sourceId,
      filePath: `opencode://${result.sessionId}`,
      linesProcessed: result.messagesProcessed,
      eventsCreated: result.eventsCreated,
      errors: result.errors,
    };
  }

  /**
   * Ingest from Cursor agent transcript
   */
  private async ingestCursorTranscript(source: Source): Promise<IngestResult> {
    const { discoverCursorTranscripts, ingestCursorTranscriptFile, normalizeCursorTranscript } = await import('./ingest/cursor.js');

    // Extract transcript ID from locator (format: cursor-transcript://{id})
    const idMatch = source.locator.match(/^cursor-transcript:\/\/(.+)$/);
    if (!idMatch) {
      return {
        sourceId: source.source_id,
        filePath: source.locator,
        linesProcessed: 0,
        eventsCreated: 0,
        errors: ['Invalid Cursor transcript locator format'],
      };
    }

    const id = idMatch[1];

    // Find the transcript
    const transcripts = discoverCursorTranscripts();
    const transcript = transcripts.find(t => t.id === id);

    if (!transcript) {
      this.db.updateSourceStatus(source.source_id, 'missing');
      return {
        sourceId: source.source_id,
        filePath: source.locator,
        linesProcessed: 0,
        eventsCreated: 0,
        errors: ['Transcript not found'],
      };
    }

    // Get cursor
    const cursor = this.db.getCursor(source.source_id);

    // Detect project from working directory
    const projectInfo = transcript.workingDir ? detectProject(transcript.workingDir) : null;
    const projectId = projectInfo?.project_id ?? `cursor-transcript-${id}`;

    // Ensure project exists
    if (projectInfo) {
      this.db.getOrCreateProject({
        ...projectInfo,
        share_policy: 'private',
      });
    }

    // Get events
    const events = normalizeCursorTranscript(transcript, {
      sourceId: source.source_id,
      deviceId: this.deviceId,
      projectId,
      workingDir: transcript.workingDir,
      redactSecrets: source.redact_secrets,
    });

    // Store events
    if (events.length > 0) {
      this.db.insertEvents(events);
    }

    // Create cursor
    const newCursor = {
      source_id: source.source_id,
      file_mtime: transcript.mtime,
      updated_at: new Date().toISOString(),
    };

    // Update cursor
    this.db.upsertCursor(newCursor);

    // Update source status
    this.db.updateSourceStatus(source.source_id, 'active');

    return {
      sourceId: source.source_id,
      filePath: transcript.filePath,
      linesProcessed: 0,
      eventsCreated: events.length,
      errors: [],
    };
  }

  /**
   * Ingest from Git repository
   */
  private async ingestGit(source: Source): Promise<IngestResult> {
    // Check if git repo exists
    if (!isGitRepo(source.locator)) {
      this.db.updateSourceStatus(source.source_id, 'missing');
      return {
        sourceId: source.source_id,
        filePath: source.locator,
        linesProcessed: 0,
        eventsCreated: 0,
        errors: ['Not a git repository'],
      };
    }
    
    // Get cursor
    const cursor = this.db.getCursor(source.source_id);
    
    // Get project ID from source locator
    const project = detectProject(source.locator);
    const projectId = project.project_id;
    
    // Ensure project exists
    this.db.getOrCreateProject({
      ...project,
      share_policy: 'private',
    });
    
    // Ingest
    const { events, newCursor, result } = ingestGitRepo(
      source.locator,
      cursor,
      {
        sourceId: source.source_id,
        deviceId: this.deviceId,
        projectId,
      }
    );
    
    // Store events
    if (events.length > 0) {
      this.db.insertEvents(events);
    }
    
    // Update cursor
    this.db.upsertCursor(newCursor);
    
    // Update source status
    this.db.updateSourceStatus(source.source_id, 'active');
    
    // Convert GitIngestResult to IngestResult
    return {
      sourceId: result.sourceId,
      filePath: result.gitRoot,
      linesProcessed: result.commitsProcessed + result.branchSwitchesProcessed,
      eventsCreated: result.eventsCreated,
      errors: result.errors,
    };
  }

  // ============================================================================
  // Watching (Continuous Ingestion)
  // ============================================================================

  /**
   * Start watching all sources for changes
   */
  startWatching(): void {
    if (this.running) return;
    this.running = true;
    
    // Auto-discover if enabled
    if (this.config.autoDiscover) {
      this.addClaudeCodeSource();
      this.addOpenCodeSource();
      this.addCursorSource();
    }
    
    // Start watching each source
    const sources = this.db.listSources(this.deviceId);
    for (const source of sources) {
      this.watchSource(source);
    }
    
    // Periodically re-discover new repos and sessions (every 30 seconds)
    this.rediscoverInterval = setInterval(async () => {
      try {
        // Re-discover Claude Code sources
        const { gitSources: claudeGitSources } = await this.addClaudeCodeSource();
        if (claudeGitSources.length > 0) {
          console.log(`Auto-discovered ${claudeGitSources.length} new git repo(s) from Claude Code`);
          for (const source of claudeGitSources) {
            this.watchSource(source);
          }
        }
        
        // Re-discover OpenCode sources
        const { sessionSources, gitSources: openCodeGitSources } = await this.addOpenCodeSource();
        if (sessionSources.length > 0) {
          console.log(`Auto-discovered ${sessionSources.length} new OpenCode session(s)`);
          for (const source of sessionSources) {
            this.watchSource(source);
          }
        }
        if (openCodeGitSources.length > 0) {
          console.log(`Auto-discovered ${openCodeGitSources.length} new git repo(s) from OpenCode`);
          for (const source of openCodeGitSources) {
            this.watchSource(source);
          }
        }

        // Re-discover Cursor sources (AGENT MODE ONLY)
        const { transcriptSources, gitSources: cursorGitSources } = await this.addCursorSource();
        if (transcriptSources.length > 0) {
          console.log(`Auto-discovered ${transcriptSources.length} new Cursor agent transcript(s)`);
          for (const source of transcriptSources) {
            this.watchSource(source);
          }
        }
        if (cursorGitSources.length > 0) {
          console.log(`Auto-discovered ${cursorGitSources.length} new git repo(s) from Cursor`);
          for (const source of cursorGitSources) {
            this.watchSource(source);
          }
        }
      } catch (e) {
        console.error(`Error re-discovering sources: ${e}`);
      }
    }, 300000); // 5 minutes - rediscover new sessions periodically
  }

  /**
   * Stop watching all sources
   */
  stopWatching(sourceId?: string): void {
    if (sourceId) {
      const watcher = this.watchers.get(sourceId);
      if (watcher) {
        watcher.close();
        this.watchers.delete(sourceId);
      }
    } else {
      for (const [id, watcher] of this.watchers) {
        watcher.close();
      }
      this.watchers.clear();
      
      if (this.rediscoverInterval) {
        clearInterval(this.rediscoverInterval);
        this.rediscoverInterval = undefined;
      }
      
      this.running = false;
    }
  }

  /**
   * Watch a single source for changes using chokidar
   */
  private watchSource(source: Source): void {
    if (this.watchers.has(source.source_id)) return;
    
    const ingest = async () => {
      try {
        // OpenCode sources use virtual locators, so check differently
        if (source.kind !== 'opencode_storage' && !existsSync(source.locator)) {
          if (source.status !== 'missing') {
            this.db.updateSourceStatus(source.source_id, 'missing');
          }
          return;
        }
        
        const result = await this.ingestSource(source);
        if (result.eventsCreated > 0) {
          console.log(`Ingested ${result.eventsCreated} events from ${source.locator}`);
        }
      } catch (e) {
        console.error(`Watch error for ${source.locator}: ${e}`);
      }
    };
    
    // Determine what to watch based on source kind
    let watchPath: string;
    let watchOptions: Parameters<typeof chokidar.watch>[1];
    
    if (source.kind === 'claude_code_jsonl') {
      // Watch the specific JSONL file
      watchPath = source.locator;
      watchOptions = {
        persistent: true,
        ignoreInitial: false, // Trigger on startup
        awaitWriteFinish: {
          stabilityThreshold: 100,
          pollInterval: 50,
        },
      };
    } else if (source.kind === 'opencode_storage') {
      // OpenCode: Use polling instead of file watching
      // The part/ directory has 14k+ subdirs, too heavy for chokidar
      // Poll every 5 seconds for new messages
      const pollInterval = setInterval(() => ingest(), 5000);
      
      // Store interval as a fake watcher with close() method
      const fakeWatcher = {
        close: () => clearInterval(pollInterval),
        on: () => fakeWatcher, // no-op chainable
      };
      this.watchers.set(source.source_id, fakeWatcher as any);
      
      // Initial ingest
      ingest();
      return; // Don't fall through to chokidar
    } else if (source.kind === 'git') {
      // Watch .git/logs/HEAD for commits and branch switches
      watchPath = join(source.locator, '.git', 'logs', 'HEAD');
      watchOptions = {
        persistent: true,
        ignoreInitial: false,
        awaitWriteFinish: {
          stabilityThreshold: 200,
          pollInterval: 100,
        },
      };
    } else {
      console.warn(`Unknown source kind: ${source.kind}, skipping watch`);
      return;
    }
    
    // Create watcher
    const watcher = chokidar.watch(watchPath, watchOptions);
    
    watcher
      .on('add', () => ingest())
      .on('change', () => ingest())
      .on('error', (error) => console.error(`Watcher error for ${source.locator}: ${error}`));
    
    this.watchers.set(source.source_id, watcher);
  }

  // ============================================================================
  // Search & Timeline
  // ============================================================================

  /**
   * Search events
   */
  search(request: SearchRequest): SearchResponse {
    return this.db.search(request);
  }

  /**
   * Get timeline
   */
  timeline(request: TimelineRequest): TimelineResponse {
    return this.db.timeline(request);
  }

  /**
   * Get project by path (current working directory)
   * Returns the project whose root_path matches or contains the given path
   */
  getProjectByPath(path: string): Project | undefined {
    return this.db.getProjectByPath(path);
  }

  /**
   * Resolve a project identifier to project_id
   * Accepts: project_id, display_name, path, or partial match
   */
  resolveProjectId(identifier: string): string | undefined {
    return this.db.resolveProjectId(identifier);
  }

  // ============================================================================
  // File Operations
  // ============================================================================

  /**
   * Get the content of a file as it was read/written by an agent
   */
  getFileContent(filePath: string, before?: string): {
    content: string;
    event_ts: string;
    tool_name: string;
    event_id: string;
  } | undefined {
    return this.db.getLatestFileContent(filePath, before);
  }

  /**
   * Get all versions/snapshots of a file over time
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
    return this.db.getFileHistory(filePath, options);
  }

  /**
   * Get Edit tool calls with their diffs
   */
  getEdits(options?: {
    since?: string;
    until?: string;
    project_id?: string;
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
    return this.db.getEdits(options);
  }

  /**
   * Find session ID from a phrase in user's message
   * Also returns current time, project, and directory for grounding
   */
  findSession(phrase?: string): {
    current_time: string;
    local_time: string;
    session_id: string | null;
    project_id: string | null;
    working_directory: string | null;
    matched_at?: string;
    preview?: string;
    recent_sessions?: Array<{ session_id: string; last_event: string; event_count: number }>;
  } {
    const now = new Date();
    const result: ReturnType<typeof this.findSession> = {
      current_time: now.toISOString(),
      local_time: now.toLocaleString(),
      session_id: null,
      project_id: null,
      working_directory: null,
    };
    
    if (!phrase) {
      // Return recent sessions
      result.recent_sessions = this.db.query<{ session_id: string; last_event: string; event_count: number }>(`
        SELECT session_id, MAX(event_ts) as last_event, COUNT(*) as event_count
        FROM events 
        WHERE session_id IS NOT NULL
        GROUP BY session_id
        ORDER BY last_event DESC
        LIMIT 5
      `);
      return result;
    }
    
    // Search for the phrase - also get project_id
    const match = this.db.query<{ session_id: string; project_id: string; event_ts: string; preview: string }>(`
      SELECT session_id, project_id, event_ts, substr(text_redacted, 1, 100) as preview
      FROM events 
      WHERE text_redacted LIKE ?
      ORDER BY event_ts DESC 
      LIMIT 1
    `, [`%${phrase}%`])[0];
    
    if (match) {
      result.session_id = match.session_id;
      result.project_id = match.project_id;
      result.matched_at = match.event_ts;
      result.preview = match.preview;
      
      // Get working directory from project
      if (match.project_id) {
        const project = this.db.query<{ root_path: string }>(`
          SELECT root_path FROM projects WHERE project_id = ?
        `, [match.project_id])[0];
        if (project) {
          result.working_directory = project.root_path;
        }
      }
    }
    
    return result;
  }

  /**
   * List files that have been accessed by agents
   */
  listFiles(options?: {
    since?: string;
    until?: string;
    project_id?: string;
    pattern?: string;
    limit?: number;
  }): Array<{
    file_path: string;
    last_accessed: string;
    access_count: number;
    tools_used: string[];
  }> {
    return this.db.listAccessedFiles(options);
  }



  // ============================================================================
  // Stats & Info
  // ============================================================================

  /**
   * Get service stats
   */
  stats(): {
    deviceId: string;
    deviceNickname: string;
    eventCount: number;
    sourceCount: number;
    projectCount: number;
    sources: Source[];
    projects: Project[];
  } {
    const dbStats = this.db.stats();
    const sources = this.db.listSources(this.deviceId);
    const projects = this.db.listProjects();
    
    return {
      deviceId: this.deviceId,
      deviceNickname: this.deviceNickname,
      eventCount: dbStats.eventCount,
      sourceCount: dbStats.sourceCount,
      projectCount: dbStats.projectCount,
      sources,
      projects,
    };
  }

  /**
   * Get token usage statistics with cost calculation
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
    return this.db.getTokenStats(options);
  }

  /**
   * Health check
   */
  health(): { status: 'ok' | 'error'; message: string; stats: ReturnType<RecallService['stats']> } {
    try {
      const stats = this.stats();
      return {
        status: 'ok',
        message: `Recall running. ${stats.eventCount} events indexed.`,
        stats,
      };
    } catch (e) {
      return {
        status: 'error',
        message: String(e),
        stats: {
          deviceId: this.deviceId,
          deviceNickname: this.deviceNickname,
          eventCount: 0,
          sourceCount: 0,
          projectCount: 0,
          sources: [],
          projects: [],
        },
      };
    }
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Close the service
   */
  close(): void {
    this.stopWatching();
    this.db.close();
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let instance: RecallService | null = null;

export function getRecallService(config?: RecallConfig): RecallService {
  if (!instance) {
    instance = new RecallService(config);
  }
  return instance;
}
