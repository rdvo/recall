/**
 * Recall v2: Claude Code JSONL Ingestion
 * 
 * Ingests conversation logs from Claude Code's JSONL files:
 * - ~/.claude/projects/<project-id>/<session-id>.jsonl (session transcripts)
 * - ~/.claude/history.jsonl (global command history)
 */

import { createHash } from 'crypto';
import { existsSync, statSync, openSync, readSync, closeSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, basename, dirname } from 'path';
import type { Event, EventType, Cursor, Source, SourceKind } from '../types.js';
import { redactSecrets, redactToolArgs } from '../redaction.js';
import { extractClaudeSessionId } from '../identity.js';

// ============================================================================
// Claude Code Log Format Types
// ============================================================================

/**
 * Raw line from Claude Code JSONL
 */
interface ClaudeCodeLogEntry {
  type: 'user' | 'assistant' | 'summary' | 'result';
  message?: {
    role: 'user' | 'assistant';
    content: string | ClaudeContentBlock[];
    model?: string;        // Model used (e.g. claude-opus-4-5-20251101)
    usage?: {              // Token usage
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
    };
  };
  // For assistant messages, content can include tool use
  timestamp?: string;
  sessionId?: string;
  cwd?: string;            // Working directory from session
  gitBranch?: string;      // Git branch from session
  // Additional fields we may encounter
  [key: string]: unknown;
}

interface ClaudeContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;           // tool_use id
  name?: string;         // tool name
  input?: unknown;       // tool args
  tool_use_id?: string;  // for tool_result
  content?: string | ClaudeContentBlock[];  // tool result content
}

// ============================================================================
// File Discovery
// ============================================================================

const CLAUDE_DIR = join(homedir(), '.claude');
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects');

/**
 * Discover all Claude Code JSONL files
 */
export function discoverClaudeCodeFiles(): string[] {
  const files: string[] = [];
  
  // Check for history file
  const historyFile = join(CLAUDE_DIR, 'history.jsonl');
  if (existsSync(historyFile)) {
    files.push(historyFile);
  }
  
  // Check for project session files
  if (existsSync(PROJECTS_DIR)) {
    try {
      const projects = readdirSync(PROJECTS_DIR, { withFileTypes: true });
      for (const project of projects) {
        if (project.isDirectory()) {
          const projectDir = join(PROJECTS_DIR, project.name);
          try {
            const sessionFiles = readdirSync(projectDir);
            for (const file of sessionFiles) {
              if (file.endsWith('.jsonl')) {
                files.push(join(projectDir, file));
              }
            }
          } catch {}
        }
      }
    } catch {}
  }
  
  return files;
}

/**
 * Extract working directory from Claude Code project folder name
 * Example: "-Users-rob-dev-pray" -> "/Users/rob/dev/pray"
 */
export function extractWorkingDirFromProjectPath(jsonlPath: string): string | undefined {
  const match = jsonlPath.match(/projects\/(-[^/]+)\//);
  if (!match) return undefined;
  
  const projectHash = match[1];
  
  // Claude Code uses dashes to separate path components
  // Format: -path-to-project
  if (projectHash.startsWith('-')) {
    // Remove leading dash and replace remaining dashes with slashes
    const parts = projectHash.slice(1).split('-');
    
    // Reconstruct path: -Users-rob-dev-pray -> /Users/rob/dev/pray
    const path = '/' + parts.join('/');
    
    // Validate it exists
    if (existsSync(path)) {
      return path;
    }
  }
  
  return undefined;
}

/**
 * Discover unique working directories from Claude Code sessions
 * Reads the actual cwd field from JSONL files
 */
export function discoverClaudeCodeWorkingDirs(): string[] {
  const dirs = new Set<string>();
  const files = discoverClaudeCodeFiles();
  
  for (const file of files) {
    // First try to extract from actual JSONL content
    try {
      if (existsSync(file)) {
        const fd = openSync(file, 'r');
        const buffer = Buffer.alloc(Math.min(statSync(file).size, 50000)); // Read first 50KB
        readSync(fd, buffer, 0, buffer.length, 0);
        closeSync(fd);
        
        const content = buffer.toString('utf-8');
        const lines = content.split('\n').filter(Boolean);
        
        // Parse first few lines to find cwd
        for (const line of lines.slice(0, 10)) {
          try {
            const entry: ClaudeCodeLogEntry = JSON.parse(line);
            if (entry.cwd && existsSync(entry.cwd)) {
              dirs.add(entry.cwd);
              break; // Found cwd for this file, move to next file
            }
          } catch {}
        }
      }
    } catch {}
    
    // Fallback to path-based extraction
    const dir = extractWorkingDirFromProjectPath(file);
    if (dir) {
      dirs.add(dir);
    }
  }
  
  return Array.from(dirs);
}

/**
 * Check if a path looks like Claude Code logs directory
 */
export function isClaudeCodePath(path: string): boolean {
  return path.includes('.claude') || path.includes('claude/projects');
}

// ============================================================================
// Token Metadata Helper
// ============================================================================

/**
 * Build token metadata from Claude Code message usage
 */
function buildTokenMeta(entry: ClaudeCodeLogEntry): Record<string, unknown> | undefined {
  const usage = entry.message?.usage;
  const model = entry.message?.model;
  
  if (!usage && !model) return undefined;
  
  const meta: Record<string, unknown> = {};
  
  if (model) meta.model = model;
  
  if (usage) {
    meta.tokens = {
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cache_read: usage.cache_read_input_tokens || 0,
      cache_write: (usage.cache_creation?.ephemeral_5m_input_tokens || 0) + 
                   (usage.cache_creation?.ephemeral_1h_input_tokens || 0),
    };
  }
  
  return meta;
}

// ============================================================================
// XML Tool Call Parsing (Old Claude Code Format)
// ============================================================================

interface ParsedToolCall {
  name: string;
  params: Record<string, string>;
  result?: string;  // The result that followed this tool call
}

/**
 * Parse embedded XML tool calls WITH their results from old Claude Code format.
 * 
 * Format:
 * <function_calls>
 * <invoke name="Read">
 * <parameter name="file_path">/path/to/file</parameter>
 * </invoke>
 * </function_calls>
 * <result>
 * ...file contents here...
 * </result>
 * 
 * We pair each <function_calls> block with the <result> that follows it.
 */
function parseEmbeddedToolCalls(text: string): ParsedToolCall[] {
  const toolCalls: ParsedToolCall[] = [];
  
  // Split by <function_calls> to process each call with its result
  // Pattern: <function_calls>...<invoke>...</invoke>...</function_calls><result>...</result>
  const blockRegex = /<function_calls>([\s\S]*?)<\/function_calls>(?:\s*<result>([\s\S]*?)<\/result>)?/g;
  let blockMatch;
  
  while ((blockMatch = blockRegex.exec(text)) !== null) {
    const functionCallsBlock = blockMatch[1];
    const resultBlock = blockMatch[2] || '';
    
    // Parse all <invoke> blocks within this <function_calls>
    const invokeRegex = /<invoke name="([^"]+)">([\s\S]*?)<\/invoke>/g;
    let invokeMatch;
    const invokesInBlock: ParsedToolCall[] = [];
    
    while ((invokeMatch = invokeRegex.exec(functionCallsBlock)) !== null) {
      const toolName = invokeMatch[1];
      const paramsBlock = invokeMatch[2];
      
      // Parse parameters
      const params: Record<string, string> = {};
      const paramRegex = /<parameter name="([^"]+)">([\s\S]*?)<\/parameter>/g;
      let paramMatch;
      
      while ((paramMatch = paramRegex.exec(paramsBlock)) !== null) {
        params[paramMatch[1]] = paramMatch[2];
      }
      
      invokesInBlock.push({ name: toolName, params });
    }
    
    // Attach result to the last invoke in this block (or first if only one)
    // Most tool calls have one invoke per block, but some batch multiple
    if (invokesInBlock.length > 0 && resultBlock) {
      invokesInBlock[invokesInBlock.length - 1].result = resultBlock.trim();
    }
    
    toolCalls.push(...invokesInBlock);
  }
  
  return toolCalls;
}

/**
 * Simple check if text contains embedded tool calls
 */
function hasEmbeddedToolCalls(text: string): boolean {
  return text.includes('<function_calls>') || text.includes('<invoke');
}

// ============================================================================
// File Tailing with Cursor
// ============================================================================

/**
 * Read new lines from a file since the last cursor position
 */
export function readNewLines(
  filePath: string,
  cursor?: Cursor
): { lines: string[]; newCursor: Cursor } {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  
  const stat = statSync(filePath);
  const currentInode = (stat as any).ino;
  const currentSize = stat.size;
  const currentMtime = stat.mtimeMs;
  
  // Determine starting position
  let startOffset = 0;
  
  if (cursor) {
    // Check if file was rotated (inode changed or size decreased)
    if (cursor.file_inode !== currentInode || (cursor.byte_offset && cursor.byte_offset > currentSize)) {
      // File rotated, start from beginning
      startOffset = 0;
    } else {
      // Continue from last position
      startOffset = cursor.byte_offset ?? 0;
    }
  }
  
  // Read new content
  const lines: string[] = [];
  
  if (startOffset < currentSize) {
    const fd = openSync(filePath, 'r');
    const bytesToRead = currentSize - startOffset;
    const buffer = Buffer.alloc(bytesToRead);
    
    readSync(fd, buffer, 0, bytesToRead, startOffset);
    closeSync(fd);
    
    const content = buffer.toString('utf-8');
    const rawLines = content.split('\n');
    
    // Filter empty lines and parse
    for (const line of rawLines) {
      const trimmed = line.trim();
      if (trimmed) {
        lines.push(trimmed);
      }
    }
  }
  
  const newCursor: Cursor = {
    source_id: cursor?.source_id ?? '',
    file_inode: currentInode,
    file_size: currentSize,
    file_mtime: currentMtime,
    byte_offset: currentSize,
    updated_at: new Date().toISOString(),
  };
  
  return { lines, newCursor };
}

// ============================================================================
// Event Normalization
// ============================================================================

interface NormalizationContext {
  sourceId: string;
  deviceId: string;
  projectId: string | null;
  sessionId: string | null;
  sourceKind: SourceKind;
  redactSecrets: boolean;
}

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
 * Parse a Claude Code JSONL line and normalize to Events
 */
export function normalizeClaudeCodeLine(
  line: string,
  sourceSeq: number,
  ctx: NormalizationContext
): Event[] {
  const events: Event[] = [];
  
  let entry: ClaudeCodeLogEntry;
  try {
    entry = JSON.parse(line);
  } catch (e) {
    console.warn(`Failed to parse JSONL line: ${line.slice(0, 100)}...`);
    return events;
  }
  
  const timestamp = entry.timestamp || new Date().toISOString();
  const ingestTs = new Date().toISOString();
  
  // Handle different entry types
  if (entry.type === 'user' && entry.message) {
    const text = extractTextContent(entry.message.content);
    const redacted = ctx.redactSecrets ? redactSecrets(text) : { text, manifest: { redactions: [] }, hadRedactions: false };
    
    events.push({
      event_id: generateEventId(ctx.sourceId, sourceSeq, text),
      source_id: ctx.sourceId,
      source_seq: sourceSeq,
      device_id: ctx.deviceId,
      project_id: ctx.projectId,
      session_id: ctx.sessionId ?? undefined,
      event_ts: timestamp,
      ingest_ts: ingestTs,
      source_kind: ctx.sourceKind,
      event_type: 'user_message',
      text_redacted: redacted.text,
      redaction_manifest_json: redacted.hadRedactions ? JSON.stringify(redacted.manifest) : undefined,
    });
  }
  
  if (entry.type === 'assistant' && entry.message) {
    const content = entry.message.content;
    
    if (typeof content === 'string') {
      // Check for embedded XML tool calls (old Claude Code format)
      const toolCalls = parseEmbeddedToolCalls(content);
      
      if (toolCalls.length > 0) {
        let seqOffset = 0;
        
        // Extract the text portion (before first <function_calls> or between them)
        const textPortion = content.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '').trim();
        const thinkingMatch = content.match(/<thinking>([\s\S]*?)<\/thinking>/);
        const resultMatch = content.match(/<result>([\s\S]*?)<\/result>/);
        
        // Store the assistant's text/thinking as a message
        if (textPortion || thinkingMatch) {
          const msgText = textPortion.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').replace(/<result>[\s\S]*?<\/result>/g, '').trim();
          if (msgText) {
            // DON'T redact assistant messages - they're AI-generated and safe
            const tokenMeta = buildTokenMeta(entry);
            events.push({
              event_id: generateEventId(ctx.sourceId, sourceSeq + seqOffset, msgText),
              source_id: ctx.sourceId,
              source_seq: sourceSeq + seqOffset,
              device_id: ctx.deviceId,
              project_id: ctx.projectId,
              session_id: ctx.sessionId ?? undefined,
              event_ts: timestamp,
              ingest_ts: ingestTs,
              source_kind: ctx.sourceKind,
              event_type: 'assistant_message',
              text_redacted: msgText,  // Store as-is, no redaction
              redaction_manifest_json: undefined,
              meta_json: tokenMeta ? JSON.stringify(tokenMeta) : undefined,
            });
            seqOffset++;
          }
        }
        
        // Create tool_call + tool_result event pairs for each parsed tool call
        for (const tc of toolCalls) {
          const filePaths = extractFilePaths(tc.params);
          const toolArgsJson = JSON.stringify(tc.params);
          const redactedArgs = ctx.redactSecrets ? redactToolArgs(tc.params) : toolArgsJson;
          
          // Build descriptive text for searchability
          let textDesc = `Tool: ${tc.name}`;
          if (tc.params.file_path) textDesc += ` ${tc.params.file_path}`;
          else if (tc.params.path) textDesc += ` ${tc.params.path}`;
          else if (tc.params.filePath) textDesc += ` ${tc.params.filePath}`;
          else if (tc.params.pattern) textDesc += ` pattern="${tc.params.pattern}"`;
          else if (tc.params.command) textDesc += ` $ ${String(tc.params.command).slice(0, 100)}`;
          else if (tc.params.query) textDesc += ` query="${String(tc.params.query).slice(0, 50)}"`;
          
          const toolCallId = `tool:${tc.name}:${seqOffset}`;
          
          // Tool call event
          events.push({
            event_id: generateEventId(ctx.sourceId, sourceSeq + seqOffset, toolCallId),
            source_id: ctx.sourceId,
            source_seq: sourceSeq + seqOffset,
            device_id: ctx.deviceId,
            project_id: ctx.projectId,
            session_id: ctx.sessionId ?? undefined,
            event_ts: timestamp,
            ingest_ts: ingestTs,
            source_kind: ctx.sourceKind,
            event_type: 'tool_call',
            text_redacted: textDesc,
            tool_name: tc.name,
            tool_args_json: redactedArgs,
            file_paths: filePaths.length > 0 ? filePaths : undefined,
            meta_json: JSON.stringify({ tool_call_id: toolCallId }),
          });
          seqOffset++;
          
          // Tool result event (paired with the call)
          if (tc.result) {
            // Store up to 50KB of result (enough for most files)
            const resultText = tc.result.slice(0, 50000);
            const redacted = ctx.redactSecrets 
              ? redactSecrets(resultText) 
              : { text: resultText, manifest: { redactions: [] }, hadRedactions: false };
            
            events.push({
              event_id: generateEventId(ctx.sourceId, sourceSeq + seqOffset, `result:${toolCallId}`),
              source_id: ctx.sourceId,
              source_seq: sourceSeq + seqOffset,
              device_id: ctx.deviceId,
              project_id: ctx.projectId,
              session_id: ctx.sessionId ?? undefined,
              event_ts: timestamp,
              ingest_ts: ingestTs,
              source_kind: ctx.sourceKind,
              event_type: 'tool_result',
              tool_name: tc.name,
              text_redacted: redacted.text,
              file_paths: filePaths.length > 0 ? filePaths : undefined,
              meta_json: JSON.stringify({ tool_call_id: toolCallId }),
              redaction_manifest_json: redacted.hadRedactions ? JSON.stringify(redacted.manifest) : undefined,
            });
            seqOffset++;
          }
          
          // For Write tool, also capture the content being written
          if (tc.name === 'Write' && tc.params.content) {
            const writeContent = String(tc.params.content).slice(0, 100000); // 100KB for full files
            events.push({
              event_id: generateEventId(ctx.sourceId, sourceSeq + seqOffset, `write_content:${toolCallId}`),
              source_id: ctx.sourceId,
              source_seq: sourceSeq + seqOffset,
              device_id: ctx.deviceId,
              project_id: ctx.projectId,
              session_id: ctx.sessionId ?? undefined,
              event_ts: timestamp,
              ingest_ts: ingestTs,
              source_kind: ctx.sourceKind,
              event_type: 'tool_result',
              tool_name: tc.name,
              text_redacted: writeContent, // Don't redact - LLM-generated code
              file_paths: filePaths.length > 0 ? filePaths : undefined,
              meta_json: JSON.stringify({ tool_call_id: toolCallId, is_write_content: true }),
            });
            seqOffset++;
          }
        }
      } else {
        // No embedded tool calls - simple text response
        const redacted = ctx.redactSecrets ? redactSecrets(content) : { text: content, manifest: { redactions: [] }, hadRedactions: false };
        const tokenMeta = buildTokenMeta(entry);
        
        events.push({
          event_id: generateEventId(ctx.sourceId, sourceSeq, content),
          source_id: ctx.sourceId,
          source_seq: sourceSeq,
          device_id: ctx.deviceId,
          project_id: ctx.projectId,
          session_id: ctx.sessionId ?? undefined,
          event_ts: timestamp,
          ingest_ts: ingestTs,
          source_kind: ctx.sourceKind,
          event_type: 'assistant_message',
          text_redacted: redacted.text,
          redaction_manifest_json: redacted.hadRedactions ? JSON.stringify(redacted.manifest) : undefined,
          meta_json: tokenMeta ? JSON.stringify(tokenMeta) : undefined,
        });
      }
    } else if (Array.isArray(content)) {
      // Content blocks (text + tool use)
      let seqOffset = 0;
      
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          // Check for embedded XML tool calls in text blocks (old format within array)
          const embeddedToolCalls = parseEmbeddedToolCalls(block.text);
          
          if (embeddedToolCalls.length > 0) {
            // Extract clean text (remove XML)
            const cleanText = block.text
              .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
              .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
              .replace(/<result>[\s\S]*?<\/result>/g, '')
              .trim();
            
            if (cleanText) {
              // DON'T redact assistant messages - they're AI-generated and safe
              const tokenMeta = buildTokenMeta(entry);
              events.push({
                event_id: generateEventId(ctx.sourceId, sourceSeq + seqOffset, cleanText),
                source_id: ctx.sourceId,
                source_seq: sourceSeq + seqOffset,
                device_id: ctx.deviceId,
                project_id: ctx.projectId,
                session_id: ctx.sessionId ?? undefined,
                event_ts: timestamp,
                ingest_ts: ingestTs,
                source_kind: ctx.sourceKind,
                event_type: 'assistant_message',
                text_redacted: cleanText,  // Store as-is, no redaction
                redaction_manifest_json: undefined,
                meta_json: tokenMeta ? JSON.stringify(tokenMeta) : undefined,
              });
              seqOffset++;
            }
            
            // Create tool_call + tool_result event pairs
            for (const tc of embeddedToolCalls) {
              const filePaths = extractFilePaths(tc.params);
              const toolArgsJson = JSON.stringify(tc.params);
              const redactedArgs = ctx.redactSecrets ? redactToolArgs(tc.params) : toolArgsJson;
              
              // Build searchable text description
              let textDesc = `Tool: ${tc.name}`;
              if (tc.params.file_path) textDesc += ` ${tc.params.file_path}`;
              else if (tc.params.path) textDesc += ` ${tc.params.path}`;
              else if (tc.params.filePath) textDesc += ` ${tc.params.filePath}`;
              else if (tc.params.pattern) textDesc += ` pattern="${tc.params.pattern}"`;
              else if (tc.params.command) textDesc += ` $ ${String(tc.params.command).slice(0, 100)}`;
              else if (tc.params.query) textDesc += ` query="${String(tc.params.query).slice(0, 50)}"`;
              
              const toolCallId = `tool:${tc.name}:${seqOffset}`;
              
              // Tool call event
              events.push({
                event_id: generateEventId(ctx.sourceId, sourceSeq + seqOffset, toolCallId),
                source_id: ctx.sourceId,
                source_seq: sourceSeq + seqOffset,
                device_id: ctx.deviceId,
                project_id: ctx.projectId,
                session_id: ctx.sessionId ?? undefined,
                event_ts: timestamp,
                ingest_ts: ingestTs,
                source_kind: ctx.sourceKind,
                event_type: 'tool_call',
                text_redacted: textDesc,
                tool_name: tc.name,
                tool_args_json: redactedArgs,
                file_paths: filePaths.length > 0 ? filePaths : undefined,
                meta_json: JSON.stringify({ tool_call_id: toolCallId }),
              });
              seqOffset++;
              
              // Tool result event (paired with the call)
              if (tc.result) {
                // Store up to 50KB of result (enough for most files)
                const resultText = tc.result.slice(0, 50000);
                const redacted = ctx.redactSecrets 
                  ? redactSecrets(resultText) 
                  : { text: resultText, manifest: { redactions: [] }, hadRedactions: false };
                
                events.push({
                  event_id: generateEventId(ctx.sourceId, sourceSeq + seqOffset, `result:${toolCallId}`),
                  source_id: ctx.sourceId,
                  source_seq: sourceSeq + seqOffset,
                  device_id: ctx.deviceId,
                  project_id: ctx.projectId,
                  session_id: ctx.sessionId ?? undefined,
                  event_ts: timestamp,
                  ingest_ts: ingestTs,
                  source_kind: ctx.sourceKind,
                  event_type: 'tool_result',
                  tool_name: tc.name,
                  text_redacted: redacted.text,
                  file_paths: filePaths.length > 0 ? filePaths : undefined,
                  meta_json: JSON.stringify({ tool_call_id: toolCallId }),
                  redaction_manifest_json: redacted.hadRedactions ? JSON.stringify(redacted.manifest) : undefined,
                });
                seqOffset++;
              }
              
              // For Write tool, also capture the content being written
              if (tc.name === 'Write' && tc.params.content) {
                const writeContent = String(tc.params.content).slice(0, 100000); // 100KB for full files
                events.push({
                  event_id: generateEventId(ctx.sourceId, sourceSeq + seqOffset, `write_content:${toolCallId}`),
                  source_id: ctx.sourceId,
                  source_seq: sourceSeq + seqOffset,
                  device_id: ctx.deviceId,
                  project_id: ctx.projectId,
                  session_id: ctx.sessionId ?? undefined,
                  event_ts: timestamp,
                  ingest_ts: ingestTs,
                  source_kind: ctx.sourceKind,
                  event_type: 'tool_result',
                  tool_name: tc.name,
                  text_redacted: writeContent, // Don't redact - LLM-generated code
                  file_paths: filePaths.length > 0 ? filePaths : undefined,
                  meta_json: JSON.stringify({ tool_call_id: toolCallId, is_write_content: true }),
                });
                seqOffset++;
              }
            }
          } else {
            // No embedded tool calls - plain text assistant message (DON'T redact - AI-generated, safe)
            const tokenMeta = buildTokenMeta(entry);
            events.push({
              event_id: generateEventId(ctx.sourceId, sourceSeq + seqOffset, block.text),
              source_id: ctx.sourceId,
              source_seq: sourceSeq + seqOffset,
              device_id: ctx.deviceId,
              project_id: ctx.projectId,
              session_id: ctx.sessionId ?? undefined,
              event_ts: timestamp,
              ingest_ts: ingestTs,
              source_kind: ctx.sourceKind,
              event_type: 'assistant_message',
              text_redacted: block.text,  // Store as-is, no redaction
              redaction_manifest_json: undefined,
              meta_json: tokenMeta ? JSON.stringify(tokenMeta) : undefined,
            });
            seqOffset++;
          }
        }
        
        if (block.type === 'tool_use' && block.name) {
          const toolName = block.name;
          const toolArgs = ctx.redactSecrets ? redactToolArgs(block.input) : JSON.stringify(block.input);
          const textDesc = `Tool call: ${toolName}`;
          const filePaths = extractFilePaths(block.input);
          
          events.push({
            event_id: generateEventId(ctx.sourceId, sourceSeq + seqOffset, `tool_use:${block.id}`),
            source_id: ctx.sourceId,
            source_seq: sourceSeq + seqOffset,
            device_id: ctx.deviceId,
            project_id: ctx.projectId,
            session_id: ctx.sessionId ?? undefined,
            event_ts: timestamp,
            ingest_ts: ingestTs,
            source_kind: ctx.sourceKind,
            event_type: 'tool_call',
            text_redacted: textDesc,
            tool_name: toolName,
            tool_args_json: toolArgs,
            file_paths: filePaths.length > 0 ? filePaths : undefined,
            meta_json: block.id ? JSON.stringify({ tool_use_id: block.id }) : undefined,
          });
          seqOffset++;
          
          // For Write tool, also capture the file content being written as a tool_result
          // This gives us the full picture of what the LLM generated
          const inputObj = block.input as Record<string, unknown>;
          if (toolName === 'Write' && inputObj?.content) {
            const writeContent = String(inputObj.content).slice(0, 100000); // 100KB for full files
            // Don't redact Write content - it's LLM-generated code, not user secrets
            events.push({
              event_id: generateEventId(ctx.sourceId, sourceSeq + seqOffset, `write_content:${block.id}`),
              source_id: ctx.sourceId,
              source_seq: sourceSeq + seqOffset,
              device_id: ctx.deviceId,
              project_id: ctx.projectId,
              session_id: ctx.sessionId ?? undefined,
              event_ts: timestamp,
              ingest_ts: ingestTs,
              source_kind: ctx.sourceKind,
              event_type: 'tool_result',
              text_redacted: writeContent,
              tool_name: toolName,
              file_paths: filePaths.length > 0 ? filePaths : undefined,
              meta_json: block.id ? JSON.stringify({ tool_use_id: block.id, is_write_content: true }) : undefined,
            });
            seqOffset++;
          }
        }
        
        if (block.type === 'tool_result') {
          const resultText = extractTextContent(block.content);
          const redacted = ctx.redactSecrets ? redactSecrets(resultText) : { text: resultText, manifest: { redactions: [] }, hadRedactions: false };
          
          events.push({
            event_id: generateEventId(ctx.sourceId, sourceSeq + seqOffset, `tool_result:${block.tool_use_id}`),
            source_id: ctx.sourceId,
            source_seq: sourceSeq + seqOffset,
            device_id: ctx.deviceId,
            project_id: ctx.projectId,
            session_id: ctx.sessionId ?? undefined,
            event_ts: timestamp,
            ingest_ts: ingestTs,
            source_kind: ctx.sourceKind,
            event_type: 'tool_result',
            text_redacted: redacted.text.slice(0, 10000), // Truncate large results
            meta_json: block.tool_use_id ? JSON.stringify({ tool_use_id: block.tool_use_id }) : undefined,
            redaction_manifest_json: redacted.hadRedactions ? JSON.stringify(redacted.manifest) : undefined,
          });
          seqOffset++;
        }
      }
    }
  }
  
  // Handle result type (tool results at top level)
  if (entry.type === 'result') {
    const text = typeof entry.message === 'string' 
      ? entry.message 
      : JSON.stringify(entry.message).slice(0, 5000);
    const redacted = ctx.redactSecrets ? redactSecrets(text) : { text, manifest: { redactions: [] }, hadRedactions: false };
    
    events.push({
      event_id: generateEventId(ctx.sourceId, sourceSeq, text),
      source_id: ctx.sourceId,
      source_seq: sourceSeq,
      device_id: ctx.deviceId,
      project_id: ctx.projectId,
      session_id: ctx.sessionId ?? undefined,
      event_ts: timestamp,
      ingest_ts: ingestTs,
      source_kind: ctx.sourceKind,
      event_type: 'tool_result',
      text_redacted: redacted.text,
      redaction_manifest_json: redacted.hadRedactions ? JSON.stringify(redacted.manifest) : undefined,
    });
  }
  
  return events;
}

/**
 * Extract text content from various content formats
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          if ('text' in block && typeof block.text === 'string') return block.text;
          if ('content' in block) return extractTextContent(block.content);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  
  if (content && typeof content === 'object' && 'text' in content) {
    return String((content as any).text);
  }
  
  return '';
}

/**
 * Extract file paths from tool arguments
 */
function extractFilePaths(input: unknown): string[] {
  const paths: string[] = [];
  
  if (!input || typeof input !== 'object') return paths;
  
  const obj = input as Record<string, unknown>;
  
  // Common path field names
  const pathFields = ['path', 'file', 'filePath', 'file_path', 'filename', 'target', 'source', 'dest', 'destination'];
  
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

// ============================================================================
// Ingestion Orchestrator
// ============================================================================

export interface IngestResult {
  sourceId: string;
  filePath: string;
  linesProcessed: number;
  eventsCreated: number;
  errors: string[];
}

/**
 * Ingest new events from a Claude Code JSONL file
 */
export function ingestClaudeCodeFile(
  filePath: string,
  cursor: Cursor | undefined,
  ctx: Omit<NormalizationContext, 'sessionId'>
): { events: Event[]; newCursor: Cursor; result: IngestResult } {
  const result: IngestResult = {
    sourceId: ctx.sourceId,
    filePath,
    linesProcessed: 0,
    eventsCreated: 0,
    errors: [],
  };
  
  // Extract session ID from file path
  const sessionId = extractClaudeSessionId(filePath);
  
  const fullCtx: NormalizationContext = {
    ...ctx,
    sessionId: sessionId ?? null,
  };
  
  // Read new lines
  const { lines, newCursor } = readNewLines(filePath, cursor);
  newCursor.source_id = ctx.sourceId;
  
  // Get starting sequence number
  let sourceSeq = cursor?.last_rowid ?? 0;
  
  // Process lines
  const events: Event[] = [];
  
  for (const line of lines) {
    result.linesProcessed++;
    
    try {
      const lineEvents = normalizeClaudeCodeLine(line, sourceSeq, fullCtx);
      events.push(...lineEvents);
      sourceSeq += Math.max(1, lineEvents.length);
    } catch (e) {
      result.errors.push(`Line ${result.linesProcessed}: ${e}`);
    }
  }
  
  result.eventsCreated = events.length;
  newCursor.last_rowid = sourceSeq;
  
  return { events, newCursor, result };
}
