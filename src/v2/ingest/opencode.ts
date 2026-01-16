/**
 * Recall v2: OpenCode Storage Ingestion
 * 
 * Ingests conversation logs from OpenCode's storage directory:
 * - ~/.local/share/opencode/storage/
 * 
 * Structure:
 * - project/{project-hash}.json - Project metadata
 * - session/{project-hash}/{session-id}.json - Session metadata
 * - message/{session-id}/{message-id}.json - Message metadata
 * - part/{message-id}/{part-id}.json - Message parts (tool calls, text, reasoning)
 * - session_diff/{session-id}.json - File diffs
 * - snapshot/{hash}/objects/ - File snapshots
 * - todo/{session-id}.json - Todo items
 */

import { createHash } from 'crypto';
import { existsSync, statSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';
import type { Event, EventType, Cursor, SourceKind } from '../types.js';
import { redactSecrets, redactToolArgs } from '../redaction.js';

// ============================================================================
// Constants
// ============================================================================

export const OPENCODE_STORAGE_DIR = join(homedir(), '.local', 'share', 'opencode', 'storage');

// ============================================================================
// OpenCode Data Types
// ============================================================================

/**
 * Project metadata from project/{hash}.json
 */
export interface OpenCodeProject {
  id: string;
  worktree: string;  // Working directory path
  vcs?: string;      // "git" or undefined
  time: {
    created: number;
    updated: number;
  };
}

/**
 * Session metadata from session/{project-hash}/{session-id}.json
 */
export interface OpenCodeSession {
  id: string;
  version: string;
  projectID: string;
  directory: string;
  title?: string;
  time: {
    created: number;
    updated: number;
  };
  summary?: {
    additions: number;
    deletions: number;
    files: number;
  };
}

/**
 * Message metadata from message/{session-id}/{message-id}.json
 */
export interface OpenCodeMessage {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  time: {
    created: number;
    completed?: number;
  };
  parentID?: string;
  modelID?: string;
  providerID?: string;
  mode?: string;
  agent?: string;
  path?: {
    cwd: string;
    root: string;
  };
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache?: {
      read: number;
      write: number;
    };
  };
  finish?: string;
}

/**
 * Part types from part/{message-id}/{part-id}.json
 */
export type OpenCodePartType = 'tool' | 'text' | 'reasoning' | 'step-start' | 'step-finish';

export interface OpenCodePartBase {
  id: string;
  sessionID: string;
  messageID: string;
  type: OpenCodePartType;
  time?: {
    start?: number;
    end?: number;
  };
}

export interface OpenCodeToolPart extends OpenCodePartBase {
  type: 'tool';
  callID: string;
  tool: string;
  state: {
    status: 'completed' | 'pending' | 'error';
    input: Record<string, unknown>;
    output?: string;
    title?: string;
    metadata?: {
      output?: string;
      exit?: number;
      description?: string;
      [key: string]: unknown;
    };
    time?: {
      start: number;
      end: number;
    };
  };
}

export interface OpenCodeTextPart extends OpenCodePartBase {
  type: 'text';
  text: string;
}

export interface OpenCodeReasoningPart extends OpenCodePartBase {
  type: 'reasoning';
  text: string;
  metadata?: {
    anthropic?: {
      signature?: string;
    };
  };
}

export interface OpenCodeStepStartPart extends OpenCodePartBase {
  type: 'step-start';
  snapshot?: string;
}

export interface OpenCodeStepFinishPart extends OpenCodePartBase {
  type: 'step-finish';
  reason?: string;
  snapshot?: string;
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache?: {
      read: number;
      write: number;
    };
  };
}

export type OpenCodePart = 
  | OpenCodeToolPart 
  | OpenCodeTextPart 
  | OpenCodeReasoningPart 
  | OpenCodeStepStartPart 
  | OpenCodeStepFinishPart;

/**
 * Session diff from session_diff/{session-id}.json
 */
export interface OpenCodeSessionDiff {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
}

// ============================================================================
// Discovery Functions
// ============================================================================

/**
 * Check if OpenCode storage directory exists
 */
export function hasOpenCodeStorage(): boolean {
  return existsSync(OPENCODE_STORAGE_DIR);
}

/**
 * Discover all OpenCode projects
 */
export function discoverOpenCodeProjects(): OpenCodeProject[] {
  const projectDir = join(OPENCODE_STORAGE_DIR, 'project');
  if (!existsSync(projectDir)) return [];
  
  const projects: OpenCodeProject[] = [];
  
  try {
    const files = readdirSync(projectDir);
    for (const file of files) {
      if (file.endsWith('.json') && file !== 'global.json') {
        try {
          const projectPath = join(projectDir, file);
          const data = JSON.parse(readFileSync(projectPath, 'utf-8'));
          if (data.id && data.worktree) {
            projects.push(data as OpenCodeProject);
          }
        } catch {}
      }
    }
  } catch {}
  
  return projects;
}

/**
 * Discover all OpenCode sessions
 */
export function discoverOpenCodeSessions(projectId?: string): OpenCodeSession[] {
  const sessionDir = join(OPENCODE_STORAGE_DIR, 'session');
  if (!existsSync(sessionDir)) return [];
  
  const sessions: OpenCodeSession[] = [];
  
  try {
    const projectDirs = readdirSync(sessionDir, { withFileTypes: true });
    
    for (const projectEntry of projectDirs) {
      if (!projectEntry.isDirectory()) continue;
      
      // Skip if filtering by project and this isn't it
      if (projectId && projectEntry.name !== projectId) continue;
      
      const projectSessionDir = join(sessionDir, projectEntry.name);
      try {
        const sessionFiles = readdirSync(projectSessionDir);
        
        for (const sessionFile of sessionFiles) {
          if (sessionFile.endsWith('.json')) {
            try {
              const sessionPath = join(projectSessionDir, sessionFile);
              const data = JSON.parse(readFileSync(sessionPath, 'utf-8'));
              if (data.id && data.projectID) {
                sessions.push(data as OpenCodeSession);
              }
            } catch {}
          }
        }
      } catch {}
    }
  } catch {}
  
  // Sort by created time (newest first)
  sessions.sort((a, b) => b.time.created - a.time.created);
  
  return sessions;
}

/**
 * Discover unique working directories from OpenCode projects
 */
export function discoverOpenCodeWorkingDirs(): string[] {
  const projects = discoverOpenCodeProjects();
  const dirs = new Set<string>();
  
  for (const project of projects) {
    if (project.worktree && existsSync(project.worktree)) {
      dirs.add(project.worktree);
    }
  }
  
  return Array.from(dirs);
}

/**
 * Get all session IDs as source locators (for tracking)
 * Returns: Map of session ID to session metadata
 */
export function discoverOpenCodeSessionLocators(): Map<string, OpenCodeSession> {
  const sessions = discoverOpenCodeSessions();
  const locators = new Map<string, OpenCodeSession>();
  
  for (const session of sessions) {
    locators.set(session.id, session);
  }
  
  return locators;
}

// ============================================================================
// File Reading Functions
// ============================================================================

/**
 * Read project metadata
 */
export function readOpenCodeProject(projectId: string): OpenCodeProject | null {
  const projectPath = join(OPENCODE_STORAGE_DIR, 'project', `${projectId}.json`);
  if (!existsSync(projectPath)) return null;
  
  try {
    const data = JSON.parse(readFileSync(projectPath, 'utf-8'));
    return data as OpenCodeProject;
  } catch {
    return null;
  }
}

/**
 * Read session metadata
 */
export function readOpenCodeSession(projectId: string, sessionId: string): OpenCodeSession | null {
  const sessionPath = join(OPENCODE_STORAGE_DIR, 'session', projectId, `${sessionId}.json`);
  if (!existsSync(sessionPath)) return null;
  
  try {
    const data = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    return data as OpenCodeSession;
  } catch {
    return null;
  }
}

/**
 * Read all messages for a session (sorted by time)
 */
export function readSessionMessages(sessionId: string): OpenCodeMessage[] {
  const messageDir = join(OPENCODE_STORAGE_DIR, 'message', sessionId);
  if (!existsSync(messageDir)) return [];
  
  const messages: OpenCodeMessage[] = [];
  
  try {
    const files = readdirSync(messageDir);
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const messagePath = join(messageDir, file);
          const data = JSON.parse(readFileSync(messagePath, 'utf-8'));
          if (data.id && data.sessionID) {
            messages.push(data as OpenCodeMessage);
          }
        } catch {}
      }
    }
  } catch {}
  
  // Sort by created time
  messages.sort((a, b) => a.time.created - b.time.created);
  
  return messages;
}

/**
 * Read all parts for a message (sorted by time)
 */
export function readMessageParts(messageId: string): OpenCodePart[] {
  const partDir = join(OPENCODE_STORAGE_DIR, 'part', messageId);
  if (!existsSync(partDir)) return [];
  
  const parts: OpenCodePart[] = [];
  
  try {
    const files = readdirSync(partDir);
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const partPath = join(partDir, file);
          const data = JSON.parse(readFileSync(partPath, 'utf-8'));
          if (data.id && data.type) {
            parts.push(data as OpenCodePart);
          }
        } catch {}
      }
    }
  } catch {}
  
  // Sort by time (use start time if available)
  parts.sort((a, b) => {
    const aTime = a.time?.start || 0;
    const bTime = b.time?.start || 0;
    return aTime - bTime;
  });
  
  return parts;
}

/**
 * Read session diffs (file edits)
 */
export function readSessionDiffs(sessionId: string): OpenCodeSessionDiff[] {
  const diffPath = join(OPENCODE_STORAGE_DIR, 'session_diff', `${sessionId}.json`);
  if (!existsSync(diffPath)) return [];
  
  try {
    const data = JSON.parse(readFileSync(diffPath, 'utf-8'));
    if (Array.isArray(data)) {
      return data as OpenCodeSessionDiff[];
    }
  } catch {}
  
  return [];
}

// ============================================================================
// Normalization Context
// ============================================================================

interface NormalizationContext {
  sourceId: string;
  deviceId: string;
  projectId: string | null;
  sessionId: string | null;
  sourceKind: SourceKind;
  redactSecrets: boolean;
}

// ============================================================================
// Event Normalization
// ============================================================================

/**
 * Generate stable event ID
 */
function generateEventId(sourceId: string, sourceSeq: number, content: string): string {
  const hash = createHash('sha256')
    .update(`${sourceId}:${sourceSeq}:${content}`)
    .digest('hex')
    .slice(0, 32);
  return `evt_${hash}`;
}

/**
 * Extract file paths from tool arguments
 */
function extractFilePaths(input: unknown): string[] {
  const paths: string[] = [];
  
  if (!input || typeof input !== 'object') return paths;
  
  const obj = input as Record<string, unknown>;
  
  // Common path field names
  const pathFields = ['path', 'file', 'filePath', 'file_path', 'filename', 'target', 'source', 'dest', 'destination', 'workdir'];
  
  for (const field of pathFields) {
    if (field in obj && typeof obj[field] === 'string') {
      paths.push(obj[field] as string);
    }
  }
  
  // Check for paths array
  if ('paths' in obj && Array.isArray(obj.paths)) {
    for (const p of obj.paths) {
      if (typeof p === 'string') paths.push(p);
    }
  }
  
  return paths;
}

/**
 * Normalize a tool part to events
 */
function normalizeToolPart(
  part: OpenCodeToolPart,
  message: OpenCodeMessage,
  sourceSeq: number,
  ctx: NormalizationContext
): Event[] {
  const events: Event[] = [];
  const timestamp = message.time.created 
    ? new Date(message.time.created).toISOString() 
    : new Date().toISOString();
  const ingestTs = new Date().toISOString();
  
  const filePaths = extractFilePaths(part.state.input);
  const toolArgsJson = JSON.stringify(part.state.input);
  const redactedArgs = ctx.redactSecrets ? redactToolArgs(part.state.input) : toolArgsJson;
  
  // Build descriptive text for searchability
  let textDesc = `Tool: ${part.tool}`;
  const input = part.state.input as Record<string, unknown>;
  if (input.filePath) textDesc += ` ${input.filePath}`;
  else if (input.path) textDesc += ` ${input.path}`;
  else if (input.file_path) textDesc += ` ${input.file_path}`;
  else if (input.pattern) textDesc += ` pattern="${String(input.pattern).slice(0, 50)}"`;
  else if (input.command) textDesc += ` $ ${String(input.command).slice(0, 100)}`;
  else if (input.query) textDesc += ` query="${String(input.query).slice(0, 50)}"`;
  
  const toolCallId = part.callID || `tool:${part.tool}:${sourceSeq}`;
  
  // Build metadata
  const meta: Record<string, unknown> = {
    tool_call_id: toolCallId,
    message_id: message.id,
    agent: message.agent,
    model: message.modelID,
    provider: message.providerID,
    ...(message.tokens && {
      tokens: {
        input: message.tokens.input || 0,
        output: message.tokens.output || 0,
        reasoning: message.tokens.reasoning || 0,
        cache_read: message.tokens.cache?.read || 0,
        cache_write: message.tokens.cache?.write || 0,
      },
    }),
    ...(message.cost && { cost: message.cost }),
  };
  
  // Add timing if available
  if (part.state.time) {
    meta.duration_ms = part.state.time.end - part.state.time.start;
  }
  
  // Add exit code if available (for bash)
  if (part.state.metadata?.exit !== undefined) {
    meta.exit_code = part.state.metadata.exit;
  }
  
  // Tool call event
  events.push({
    event_id: generateEventId(ctx.sourceId, sourceSeq, toolCallId),
    source_id: ctx.sourceId,
    source_seq: sourceSeq,
    device_id: ctx.deviceId,
    project_id: ctx.projectId,
    session_id: ctx.sessionId ?? undefined,
    event_ts: timestamp,
    ingest_ts: ingestTs,
    source_kind: ctx.sourceKind,
    event_type: 'tool_call',
    text_redacted: textDesc,
    tool_name: part.tool,
    tool_args_json: redactedArgs,
    file_paths: filePaths.length > 0 ? filePaths : undefined,
    meta_json: JSON.stringify(meta),
  });
  
  // Tool result event - capture output OR write content
  // For Write tool, content is in state.input.content (the file being written)
  // For Read tool, content is in state.output (the file contents read)
  // For other tools, output is in state.output or state.metadata.output
  let resultText: string | undefined;
  
  if (part.tool === 'write' && input.content) {
    // Write tool: capture the file content being written
    resultText = String(input.content).slice(0, 200000); // 200KB for full files
  } else if (part.tool === 'read' || part.tool === 'Read') {
    // Read tool: capture full file content (up to 200KB)
    const output = part.state.output || part.state.metadata?.output || '';
    resultText = String(output).slice(0, 200000); // 200KB for file reads
  } else if (part.state.output || part.state.metadata?.output) {
    // Other tools: capture their output
    const output = part.state.output || part.state.metadata?.output || '';
    resultText = String(output).slice(0, 50000); // 50KB for tool outputs
  }
  
  if (resultText) {
    const redacted = ctx.redactSecrets 
      ? redactSecrets(resultText) 
      : { text: resultText, manifest: { redactions: [] }, hadRedactions: false };
    
    events.push({
      event_id: generateEventId(ctx.sourceId, sourceSeq + 0.5, `result:${toolCallId}`),
      source_id: ctx.sourceId,
      source_seq: sourceSeq + 0.5,
      device_id: ctx.deviceId,
      project_id: ctx.projectId,
      session_id: ctx.sessionId ?? undefined,
      event_ts: timestamp,
      ingest_ts: ingestTs,
      source_kind: ctx.sourceKind,
      event_type: 'tool_result',
      tool_name: part.tool,
      text_redacted: redacted.text,
      file_paths: filePaths.length > 0 ? filePaths : undefined,
      meta_json: JSON.stringify({ tool_call_id: toolCallId, message_id: message.id }),
      redaction_manifest_json: redacted.hadRedactions ? JSON.stringify(redacted.manifest) : undefined,
    });
  }
  
  return events;
}

/**
 * Normalize a text part to an event
 */
function normalizeTextPart(
  part: OpenCodeTextPart,
  message: OpenCodeMessage,
  sourceSeq: number,
  ctx: NormalizationContext
): Event {
  const timestamp = message.time.created 
    ? new Date(message.time.created).toISOString() 
    : new Date().toISOString();
  const ingestTs = new Date().toISOString();
  
  const eventType: EventType = message.role === 'user' ? 'user_message' : 'assistant_message';
  
  // Only redact user messages (assistant messages are AI-generated and safe)
  const text = part.text;
  const redacted = (eventType === 'user_message' && ctx.redactSecrets)
    ? redactSecrets(text)
    : { text, manifest: { redactions: [] }, hadRedactions: false };
  
  return {
    event_id: generateEventId(ctx.sourceId, sourceSeq, text),
    source_id: ctx.sourceId,
    source_seq: sourceSeq,
    device_id: ctx.deviceId,
    project_id: ctx.projectId,
    session_id: ctx.sessionId ?? undefined,
    event_ts: timestamp,
    ingest_ts: ingestTs,
    source_kind: ctx.sourceKind,
    event_type: eventType,
    text_redacted: redacted.text,
    redaction_manifest_json: redacted.hadRedactions ? JSON.stringify(redacted.manifest) : undefined,
    meta_json: JSON.stringify({ 
      message_id: message.id,
      ...(message.modelID && { model: message.modelID }),
      ...(message.providerID && { provider: message.providerID }),
      ...(message.agent && { agent: message.agent }),
      ...(message.tokens && {
        tokens: {
          input: message.tokens.input || 0,
          output: message.tokens.output || 0,
          reasoning: message.tokens.reasoning || 0,
          cache_read: message.tokens.cache?.read || 0,
          cache_write: message.tokens.cache?.write || 0,
        }
      }),
      ...(message.cost && { cost: message.cost }),
    }),
  };
}

/**
 * Normalize a reasoning part to an event
 */
function normalizeReasoningPart(
  part: OpenCodeReasoningPart,
  message: OpenCodeMessage,
  sourceSeq: number,
  ctx: NormalizationContext
): Event {
  const timestamp = message.time.created 
    ? new Date(message.time.created).toISOString() 
    : new Date().toISOString();
  const ingestTs = new Date().toISOString();
  
  // Reasoning is always from assistant
  return {
    event_id: generateEventId(ctx.sourceId, sourceSeq, part.text),
    source_id: ctx.sourceId,
    source_seq: sourceSeq,
    device_id: ctx.deviceId,
    project_id: ctx.projectId,
    session_id: ctx.sessionId ?? undefined,
    event_ts: timestamp,
    ingest_ts: ingestTs,
    source_kind: ctx.sourceKind,
    event_type: 'assistant_message',
    text_redacted: part.text,
    meta_json: JSON.stringify({
      reasoning: true,
      message_id: message.id,
      ...(message.modelID && { model: message.modelID }),
      ...(message.providerID && { provider: message.providerID }),
      ...(message.agent && { agent: message.agent }),
      ...(message.tokens && {
        tokens: {
          input: message.tokens.input || 0,
          output: message.tokens.output || 0,
          reasoning: message.tokens.reasoning || 0,
          cache_read: message.tokens.cache?.read || 0,
          cache_write: message.tokens.cache?.write || 0,
        }
      }),
      ...(message.cost && { cost: message.cost }),
    }),
  };
}

/**
 * Normalize session diffs to edit events
 */
function normalizeSessionDiffs(
  diffs: OpenCodeSessionDiff[],
  message: OpenCodeMessage,
  sourceSeq: number,
  ctx: NormalizationContext
): Event[] {
  const events: Event[] = [];
  const timestamp = message.time.created 
    ? new Date(message.time.created).toISOString() 
    : new Date().toISOString();
  const ingestTs = new Date().toISOString();
  
  for (let i = 0; i < diffs.length; i++) {
    const diff = diffs[i];
    const event_id = generateEventId(
      ctx.sourceId,
      sourceSeq + i,
      `${diff.file}:${i}`
    );
    
    // Store diff data in tool_args_json for getEdits() to extract
    const toolArgs = {
      file_path: diff.file,
      oldString: diff.before,
      newString: diff.after,
    };
    
    events.push({
      event_id,
      source_id: ctx.sourceId,
      source_seq: sourceSeq + i,
      device_id: ctx.deviceId,
      project_id: ctx.projectId,
      session_id: ctx.sessionId ?? undefined,
      event_ts: timestamp,
      ingest_ts: ingestTs,
      source_kind: ctx.sourceKind,
      event_type: 'tool_call',
      tool_name: 'edit',
      tool_args_json: JSON.stringify(toolArgs),
      file_paths: [diff.file],
      text_redacted: `Tool: edit ${diff.file}`,
      meta_json: JSON.stringify({
        message_id: message.id,
        additions: diff.additions,
        deletions: diff.deletions,
      }),
    });
  }
  
  return events;
}

/**
 * Normalize a single message and its parts to events
 */
function normalizeMessage(
  message: OpenCodeMessage,
  parts: OpenCodePart[],
  sourceSeq: number,
  ctx: NormalizationContext
): Event[] {
  const events: Event[] = [];
  let seqOffset = 0;
  let tokensAttached = false; // Only attach tokens once per OpenCode message

  // Message without tokens (for subsequent events)
  const messageNoTokens: OpenCodeMessage = { ...message, tokens: undefined, cost: undefined };

  for (const part of parts) {
    const msgForEvent = tokensAttached ? messageNoTokens : message;

    if (part.type === 'tool') {
      const toolEvents = normalizeToolPart(part as OpenCodeToolPart, msgForEvent, sourceSeq + seqOffset, ctx);
      events.push(...toolEvents);
      seqOffset += toolEvents.length;
      if (toolEvents.length > 0) tokensAttached = true;
    } else if (part.type === 'text') {
      events.push(normalizeTextPart(part as OpenCodeTextPart, msgForEvent, sourceSeq + seqOffset, ctx));
      seqOffset++;
      tokensAttached = true;
    } else if (part.type === 'reasoning') {
      events.push(normalizeReasoningPart(part as OpenCodeReasoningPart, msgForEvent, sourceSeq + seqOffset, ctx));
      seqOffset++;
      tokensAttached = true;
    }
    // step-start and step-finish are metadata, not content events
  }

  return events;
}

/**
 * Normalize an entire OpenCode session to Recall Events
 */
export function normalizeOpenCodeSession(
  session: OpenCodeSession,
  ctx: Omit<NormalizationContext, 'sessionId'>,
  afterTimestamp?: number
): Event[] {
  const fullCtx: NormalizationContext = {
    ...ctx,
    sessionId: session.id,
  };
  
  const messages = readSessionMessages(session.id);
  const events: Event[] = [];
  let sourceSeq = 0;
  
  for (const message of messages) {
    // Skip messages before the cursor
    if (afterTimestamp && message.time.created <= afterTimestamp) {
      continue;
    }
    
    // Skip assistant messages that haven't completed yet (tokens not available)
    // User messages don't have time.completed, so we only check for assistant
    if (message.role === 'assistant' && !message.time.completed) {
      continue;
    }
    
    const parts = readMessageParts(message.id);
    const messageEvents = normalizeMessage(message, parts, sourceSeq, fullCtx);
    events.push(...messageEvents);
    sourceSeq += Math.max(1, messageEvents.length);
  }
  
  // Read and normalize session diffs (file edits)
  const diffs = readSessionDiffs(session.id);
  if (diffs.length > 0 && messages.length > 0) {
    // Find first completed message to use as timestamp source
    const firstCompletedMessage = messages.find(m => 
      m.role === 'user' || (m.role === 'assistant' && m.time.completed)
    );
    if (firstCompletedMessage) {
      const diffEvents = normalizeSessionDiffs(diffs, firstCompletedMessage, sourceSeq, fullCtx);
      events.push(...diffEvents);
      sourceSeq += diffEvents.length;
    }
  }
  
  return events;
}

// ============================================================================
// Cursor Management
// ============================================================================

/**
 * OpenCode cursor - maps to standard Cursor fields:
 * - file_mtime = session_mtime (session file modification time)
 * - byte_offset = last_message_time (last processed message timestamp)
 * - last_event_id = last_message_id
 */
export interface OpenCodeCursor extends Cursor {
  // These map to standard cursor fields for DB storage
}

/**
 * Get the modification time of a session file
 */
function getSessionMtime(projectId: string, sessionId: string): number {
  const sessionPath = join(OPENCODE_STORAGE_DIR, 'session', projectId, `${sessionId}.json`);
  if (!existsSync(sessionPath)) return 0;
  
  try {
    return statSync(sessionPath).mtimeMs;
  } catch {
    return 0;
  }
}

// ============================================================================
// Ingestion Orchestrator
// ============================================================================

export interface OpenCodeIngestResult {
  sourceId: string;
  sessionId: string;
  messagesProcessed: number;
  eventsCreated: number;
  errors: string[];
}

/**
 * Ingest a single OpenCode session
 */
export function ingestOpenCodeSession(
  session: OpenCodeSession,
  cursor: OpenCodeCursor | undefined,
  ctx: Omit<NormalizationContext, 'sessionId'>
): { events: Event[]; newCursor: OpenCodeCursor; result: OpenCodeIngestResult } {
  const result: OpenCodeIngestResult = {
    sourceId: ctx.sourceId,
    sessionId: session.id,
    messagesProcessed: 0,
    eventsCreated: 0,
    errors: [],
  };
  
  // Check if session file has changed (session_mtime stored in file_mtime)
  const currentMtime = getSessionMtime(session.projectID, session.id);
  const currentDiffMtime = getSessionDiffMtime(session.id);
  
  const prevCursorDiffMtime = cursor?.diff_mtime;
  const shouldSkip = cursor?.file_mtime && currentMtime <= cursor.file_mtime && prevCursorDiffMtime !== undefined && prevCursorDiffMtime === currentDiffMtime;
  
  if (shouldSkip) {
    return {
      events: [],
      newCursor: cursor,
      result,
    };
  }
  
  // Determine starting point (last_message_time stored in byte_offset)
  const afterTimestamp = cursor?.byte_offset;
  
  // Get all messages for the session
  const messages = readSessionMessages(session.id);
  result.messagesProcessed = messages.length;
  
  // Filter to new messages that are complete (assistant messages need time.completed)
  const newMessages = messages.filter(m => {
    if (afterTimestamp && m.time.created <= afterTimestamp) return false;
    if (m.role === 'assistant' && !m.time.completed) return false;
    return true;
  });
  
  // Normalize events
  const events = normalizeOpenCodeSession(session, ctx, afterTimestamp);
  result.eventsCreated = events.length;
  
  // Build new cursor
  const completedMessages = messages.filter(m => 
    m.role === 'user' || (m.role === 'assistant' && m.time.completed)
  );
  const lastCompletedMessage = completedMessages[completedMessages.length - 1];
  const newCursor: OpenCodeCursor = {
    source_id: ctx.sourceId,
    last_event_id: lastCompletedMessage?.id,
    byte_offset: lastCompletedMessage?.time.created,
    file_mtime: currentMtime,
    diff_mtime: currentDiffMtime,
    updated_at: new Date().toISOString(),
    last_rowid: (cursor?.last_rowid ?? 0) + events.length,
  };
  
  return { events, newCursor, result };
}

/**
 * Get modification time of a session diff file
 */
function getSessionDiffMtime(sessionId: string): number {
  const diffPath = join(OPENCODE_STORAGE_DIR, 'session_diff', `${sessionId}.json`);
  if (!existsSync(diffPath)) return 0;
  
  try {
    return statSync(diffPath).mtimeMs;
  } catch {
    return 0;
  }
}

// ============================================================================
// High-Level Discovery for Service Integration
// ============================================================================

/**
 * Get all session locators for registration as sources
 * Each session becomes its own source for granular cursor tracking
 */
export function getOpenCodeSessionSources(): Array<{
  sessionId: string;
  projectId: string;
  locator: string;
  workingDir: string;
  title?: string;
}> {
  const sessions = discoverOpenCodeSessions();
  const projects = new Map<string, OpenCodeProject>();
  
  // Load all projects for directory lookup
  for (const project of discoverOpenCodeProjects()) {
    projects.set(project.id, project);
  }
  
  return sessions.map(session => {
    const project = projects.get(session.projectID);
    const workingDir = project?.worktree || session.directory || '';
    
    return {
      sessionId: session.id,
      projectId: session.projectID,
      locator: `opencode://${session.id}`,
      workingDir,
      title: session.title,
    };
  });
}
