/**
 * Recall v2: Cursor Agent Transcript Ingestion
 *
 * Ingests Cursor agent-mode transcripts.
 */

import { createHash } from 'crypto';
import { existsSync, statSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, basename, dirname } from 'path';
import type { Event, EventType, Cursor } from '../types.js';
import { redactSecrets, redactToolArgs } from '../redaction.js';

// ============================================================================
// Constants
// ============================================================================

export const CURSOR_PROJECTS_DIR = join(homedir(), '.cursor', 'projects');

// ============================================================================
// Cursor Data Types
// ============================================================================

/**
 * Agent transcript file from ~/.cursor/projects/
 */
export interface CursorTranscript {
  id: string;                    // UUID from filename
  projectName: string;           // e.g., "Users-rob-dev-openwrap"
  workingDir: string;            // Decoded: /Users/rob/dev/openwrap
  filePath: string;
  mtime: number;
}

/**
 * Cursor-specific cursor (progress tracking)
 */
export interface CursorCursor extends Cursor {
  file_mtime?: number;
}

/**
 * Ingest result
 */
export interface CursorIngestResult {
  source_id: string;
  events_created: number;
  cursor: CursorCursor;
}

// ============================================================================
// Discovery Functions
// ============================================================================

/**
 * Check if Cursor projects directory exists
 */
export function hasCursorProjects(): boolean {
  return existsSync(CURSOR_PROJECTS_DIR);
}

/**
 * Discover Cursor agent transcripts
 */
export function discoverCursorTranscripts(): CursorTranscript[] {
  if (!hasCursorProjects()) return [];

  const transcripts: CursorTranscript[] = [];
  const projects = readdirSync(CURSOR_PROJECTS_DIR);

  for (const projectName of projects) {
    const transcriptsDir = join(CURSOR_PROJECTS_DIR, projectName, 'agent-transcripts');
    if (!existsSync(transcriptsDir)) continue;

    const files = readdirSync(transcriptsDir).filter(f => f.endsWith('.txt'));

    for (const file of files) {
      const filePath = join(transcriptsDir, file);
      const id = basename(file, '.txt');
      const stats = statSync(filePath);

      // Decode project name to working directory
      // "Users-rob-dev-openwrap" -> "/Users/rob/dev/openwrap"
      const workingDir = '/' + projectName.replace(/-/g, '/');

      transcripts.push({
        id,
        projectName,
        workingDir,
        filePath,
        mtime: stats.mtimeMs,
      });
    }
  }

  return transcripts;
}

/**
 * Get all working directories from Cursor sources
 */
export function discoverCursorWorkingDirs(): string[] {
  const transcripts = discoverCursorTranscripts();
  const dirs = new Set(transcripts.map(t => t.workingDir));
  return Array.from(dirs);
}

export function cursorTranscriptFromPath(filePath: string): CursorTranscript | null {
  if (!filePath.endsWith('.txt')) return null;

  try {
    const transcriptsDir = dirname(filePath);
    if (basename(transcriptsDir) !== 'agent-transcripts') return null;

    const projectName = basename(dirname(transcriptsDir));
    if (!projectName) return null;

    const id = basename(filePath, '.txt');
    const stats = statSync(filePath);

    // "Users-rob-dev-openwrap" -> "/Users/rob/dev/openwrap"
    const workingDir = '/' + projectName.replace(/-/g, '/');

    return {
      id,
      projectName,
      workingDir,
      filePath,
      mtime: stats.mtimeMs,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Transcript Parsing
// ============================================================================

/**
 * Parse Cursor agent transcript (.txt file)
 */
export function parseTranscript(content: string): Array<{
  type: 'user' | 'assistant' | 'thinking' | 'tool_call' | 'tool_result';
  text: string;
  toolName?: string;
  toolArgs?: Record<string, string>;
}> {
  const blocks: Array<{
    type: 'user' | 'assistant' | 'thinking' | 'tool_call' | 'tool_result';
    text: string;
    toolName?: string;
    toolArgs?: Record<string, string>;
  }> = [];

  // Split by major sections
  const lines = content.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // User message: user:\n<user_query>
    if (line.trim() === 'user:') {
      i++;
      if (lines[i]?.trim() === '<user_query>') {
        i++;
        let text = '';
        while (i < lines.length && lines[i]?.trim() !== '</user_query>') {
          text += lines[i] + '\n';
          i++;
        }
        blocks.push({ type: 'user', text: text.trim() });
        i++; // Skip </user_query>
      }
      continue;
    }

    // Assistant response: A:
    if (line.trim() === 'A:') {
      i++;
      let text = '';

      // Look for <think> blocks or regular text
      while (i < lines.length && !lines[i]?.startsWith('user:') && !lines[i]?.startsWith('[Tool')) {
        const curr = lines[i];

        // Thinking block
        if (curr?.trim() === '<think>') {
          i++;
          let thinkText = '';
          while (i < lines.length && lines[i]?.trim() !== '</think>') {
            thinkText += lines[i] + '\n';
            i++;
          }
          blocks.push({ type: 'thinking', text: thinkText.trim() });
          i++; // Skip </think>
          continue;
        }

        // Regular assistant text
        text += curr + '\n';
        i++;
      }

      if (text.trim()) {
        blocks.push({ type: 'assistant', text: text.trim() });
      }
      continue;
    }

    // Tool call: [Tool call] ToolName
    if (line.startsWith('[Tool call] ')) {
      const toolName = line.replace('[Tool call] ', '').trim();
      i++;

      // Parse indented args
      const args: Record<string, string> = {};
      while (i < lines.length && lines[i]?.startsWith('  ')) {
        const argLine = lines[i].trim();
        const colonIdx = argLine.indexOf(':');
        if (colonIdx > 0) {
          const key = argLine.substring(0, colonIdx).trim();
          const value = argLine.substring(colonIdx + 1).trim();
          args[key] = value;
        }
        i++;
      }

      blocks.push({ type: 'tool_call', text: '', toolName, toolArgs: args });
      continue;
    }

    // Tool result: [Tool result] ToolName
    if (line.startsWith('[Tool result] ')) {
      const toolName = line.replace('[Tool result] ', '').trim();
      i++;

      // Collect result text until next section
      let text = '';
      while (i < lines.length && !lines[i]?.startsWith('A:') && !lines[i]?.startsWith('[Tool') && !lines[i]?.startsWith('user:')) {
        text += lines[i] + '\n';
        i++;
      }

      blocks.push({ type: 'tool_result', text: text.trim(), toolName });
      continue;
    }

    i++;
  }

  return blocks;
}

// ============================================================================
// File Path Extraction
// ============================================================================

/**
 * Extract file paths from tool args
 */
function extractFilePathsFromToolArgs(args: Record<string, string>): string[] {
  const paths: string[] = [];
  const pathKeys = ['path', 'file', 'filePath', 'file_path', 'target_directory', 'workdir'];

  for (const key of pathKeys) {
    if (args[key]) {
      paths.push(args[key]);
    }
  }

  return paths;
}

// ============================================================================
// Normalization Context
// ============================================================================

export interface NormalizationContext {
  sourceId: string;
  deviceId: string;
  projectId: string | null;
  workingDir: string;
  redactSecrets: boolean;
}

// ============================================================================
// Normalize Transcript
// ============================================================================

/**
 * Normalize Cursor agent transcript to events
 */
export function normalizeCursorTranscript(
  transcript: CursorTranscript,
  ctx: NormalizationContext
): Event[] {
  const content = readFileSync(transcript.filePath, 'utf-8');
  const blocks = parseTranscript(content);
  const events: Event[] = [];
  let sourceSeq = 0;

  const timestamp = new Date(transcript.mtime).toISOString();
  const sessionId = transcript.id;

  for (const block of blocks) {
    const eventType: EventType =
      block.type === 'user'
        ? 'user_message'
        : block.type === 'assistant' || block.type === 'thinking'
        ? 'assistant_message'
        : block.type === 'tool_call'
        ? 'tool_call'
        : 'tool_result';

    const text = block.text;
    const filePaths = block.toolArgs ? extractFilePathsFromToolArgs(block.toolArgs) : [];

    const payloadHash = createHash('sha256')
      .update(JSON.stringify({ text, type: block.type, toolName: block.toolName }))
      .digest('hex')
      .substring(0, 16);

    const eventId = createHash('sha256')
      .update(`${ctx.sourceId}:${sourceSeq}:${payloadHash}`)
      .digest('hex');

    const textRedacted = ctx.redactSecrets ? redactSecrets(text).text : text;

    const meta: any = {};
    if (block.type === 'thinking') meta.reasoning = true;

    let toolArgsJson: string | undefined;
    if (block.toolArgs && Object.keys(block.toolArgs).length > 0) {
      const redacted = ctx.redactSecrets ? redactToolArgs(block.toolArgs) : block.toolArgs;
      toolArgsJson = JSON.stringify(redacted);
    }

    events.push({
      event_id: eventId,
      source_id: ctx.sourceId,
      source_seq: sourceSeq++,
      device_id: ctx.deviceId,
      project_id: ctx.projectId,
      session_id: sessionId,
      event_ts: timestamp,
      ingest_ts: new Date().toISOString(),
      source_kind: 'cursor_transcript',
      event_type: eventType,
      text_redacted: textRedacted,
      tool_name: block.toolName,
      tool_args_json: toolArgsJson,
      file_paths: filePaths.length > 0 ? filePaths : undefined,
      meta_json: Object.keys(meta).length > 0 ? JSON.stringify(meta) : undefined,
    });
  }

  return events;
}

// ============================================================================
// Ingestion Functions
// ============================================================================

/**
 * Ingest Cursor transcript
 */
export function ingestCursorTranscriptFile(
  transcript: CursorTranscript,
  sourceId: string,
  ctx: Omit<NormalizationContext, 'sourceId'>
): CursorIngestResult {
  const fullCtx: NormalizationContext = { ...ctx, sourceId };

  const events = normalizeCursorTranscript(transcript, fullCtx);

  return {
    source_id: sourceId,
    events_created: events.length,
    cursor: {
      source_id: sourceId,
      file_mtime: transcript.mtime,
      updated_at: new Date().toISOString(),
    },
  };
}
