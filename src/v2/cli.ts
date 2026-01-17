#!/usr/bin/env node
/**
 * Recall v2: CLI Interface
 */

import { spawn } from 'child_process';
import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { RecallService, getRecallService } from './service.js';
import type { EventType, MessageRole } from './types.js';

// ============================================================================
// Watch Daemon Management
// ============================================================================

const PID_FILE = join(homedir(), '.local', 'share', 'recall', 'watch.pid');
const LOG_FILE = join(homedir(), '.local', 'share', 'recall', 'watch.log');

function isWatcherRunning(): { running: boolean; pid?: number } {
  if (!existsSync(PID_FILE)) {
    return { running: false };
  }
  
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    process.kill(pid, 0); // Throws if process doesn't exist
    return { running: true, pid };
  } catch {
    try { unlinkSync(PID_FILE); } catch {}
    return { running: false };
  }
}

function startWatcherDaemon(): void {
  const status = isWatcherRunning();
  if (status.running) {
    console.log(`Watcher already running (PID ${status.pid})`);
    return;
  }
  
  const child = spawn(process.execPath, [process.argv[1], 'watch', '--daemon'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, RECALL_DAEMON: '1' },
  });
  
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  
  console.log(`Watcher started (PID ${child.pid})`);
  console.log(`Log: ${LOG_FILE}`);
}

function stopWatcherDaemon(): void {
  const status = isWatcherRunning();
  if (!status.running) {
    console.log('Watcher not running');
    return;
  }
  
  try {
    process.kill(status.pid!, 'SIGTERM');
    unlinkSync(PID_FILE);
    console.log(`Watcher stopped (was PID ${status.pid})`);
  } catch (e) {
    console.error(`Failed to stop watcher: ${e}`);
  }
}

// ============================================================================
// CLI Helpers
// ============================================================================

function parseArgs(args: string[]): { command: string; subcommand?: string; flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else if (arg.startsWith('-')) {
      const key = arg.slice(1);
      const next = args[i + 1];
      
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }
  
  return {
    command: positional[0] || 'help',
    subcommand: positional[1],
    flags,
    positional: positional.slice(2),
  };
}

function formatTime(ts: string): string {
  try {
    const date = new Date(ts);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
}

function formatDate(ts: string): string {
  try {
    const date = new Date(ts);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/**
 * Build pagination metadata for JSON output
 * Includes next_command so agent can copy-paste to get more
 */
function buildPagination(offset: number, limit: number, returned: number, total: number, baseCommand: string): {
  offset: number;
  limit: number;
  returned: number;
  total: number;
  has_more: boolean;
  next_command?: string;
} {
  const has_more = offset + returned < total;
  return {
    offset,
    limit,
    returned,
    total,
    has_more,
    ...(has_more && { next_command: `${baseCommand} --offset ${offset + returned}` })
  };
}

/**
 * Print pagination footer for table output
 */
function printPaginationFooter(offset: number, returned: number, total: number, nextOffset: number): void {
  if (total > returned) {
    const start = offset + 1;
    const end = offset + returned;
    console.log(`\nShowing ${start}-${end} of ${total}.${offset + returned < total ? ` Next: --offset ${nextOffset}` : ''}`);
  }
}

/**
 * Parse time input into ISO 8601 timestamp
 * 
 * Supported formats:
 * - ISO 8601: "2026-01-08", "2026-01-08T14:30:00", "2026-01-08T14:30:00-05:00"
 * - Unix timestamp: "1704672000" (epoch seconds)
 * - Relative shorthand: "1h", "3d", "2w", "6mo", "1y"
 * - Human relative: "1 hour ago", "3 days ago", "2 weeks ago"
 * 
 * Uses LOCAL timezone for interpretation.
 */
function parseRelativeTime(input: string): string {
  const now = Date.now();
  
  // Try parsing as unix timestamp (all digits)
  if (/^\d+$/.test(input)) {
    const timestamp = parseInt(input, 10);
    // If it's a reasonable unix timestamp (year 2000+)
    if (timestamp > 946684800) {
      return new Date(timestamp * 1000).toISOString();
    }
  }
  
  // Try parsing shorthand relative: "1h", "3d", "2w", "6mo", "1y"
  const shorthandMatch = input.match(/^(\d+)(s|m|h|d|w|mo|y)$/i);
  if (shorthandMatch) {
    const amount = parseInt(shorthandMatch[1], 10);
    const unit = shorthandMatch[2].toLowerCase();
    
    let ms = 0;
    switch (unit) {
      case 's': ms = amount * 1000; break;
      case 'm': ms = amount * 60 * 1000; break;
      case 'h': ms = amount * 60 * 60 * 1000; break;
      case 'd': ms = amount * 24 * 60 * 60 * 1000; break;
      case 'w': ms = amount * 7 * 24 * 60 * 60 * 1000; break;
      case 'mo': ms = amount * 30 * 24 * 60 * 60 * 1000; break;
      case 'y': ms = amount * 365 * 24 * 60 * 60 * 1000; break;
    }
    
    return new Date(now - ms).toISOString();
  }
  
  // Try parsing human relative: "1 hour ago", "3 days ago"
  const humanMatch = input.match(/^(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago$/i);
  if (humanMatch) {
    const amount = parseInt(humanMatch[1], 10);
    const unit = humanMatch[2].toLowerCase();
    
    let ms = 0;
    switch (unit) {
      case 'second': ms = amount * 1000; break;
      case 'minute': ms = amount * 60 * 1000; break;
      case 'hour': ms = amount * 60 * 60 * 1000; break;
      case 'day': ms = amount * 24 * 60 * 60 * 1000; break;
      case 'week': ms = amount * 7 * 24 * 60 * 60 * 1000; break;
      case 'month': ms = amount * 30 * 24 * 60 * 60 * 1000; break;
      case 'year': ms = amount * 365 * 24 * 60 * 60 * 1000; break;
    }
    
    return new Date(now - ms).toISOString();
  }
  
  // Try parsing as ISO 8601 or JavaScript Date-parseable format
  // Auto-append Z if it looks like ISO format but missing timezone
  let inputToTry = input;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(input)) {
    inputToTry = input + 'Z';
  }
  
  try {
    const parsed = new Date(inputToTry);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  } catch {}
  
  // If all else fails, return as-is (will likely fail downstream)
  console.warn(`Unable to parse time: "${input}". Use formats like: "2026-01-08", "3d", "1 week ago"`);
  return input;
}

// ============================================================================
// Commands
// ============================================================================

async function cmdHealth(service: RecallService): Promise<void> {
  const health = service.health();
  
  if (health.status === 'ok') {
    console.log(`Recall running`);
    console.log(`  Device: ${health.stats.deviceNickname} (${health.stats.deviceId.slice(0, 8)}...)`);
    console.log(`  Events: ${health.stats.eventCount}`);
    console.log(`  Sources: ${health.stats.sourceCount}`);
    console.log(`  Projects: ${health.stats.projectCount}`);
  } else {
    console.error(`Recall error: ${health.message}`);
    process.exit(1);
  }
}

async function cmdProjectsList(service: RecallService, flags: Record<string, string | boolean>): Promise<void> {
  const projects = service.listProjects();
  
  if (projects.length === 0) {
    console.log('No projects found.');
    return;
  }
  
  // JSON output
  if (flags.format === 'json') {
    console.log(JSON.stringify(projects, null, 2));
    return;
  }
  
  // Human readable
  console.log(`Projects (${projects.length}):\n`);
  for (const project of projects) {
    console.log(`  ${project.project_id}`);
    console.log(`    Display: ${project.display_name || '(no name)'}`);
    console.log(`    Path: ${project.root_path}`);
  }
}

async function cmdProjectsStatus(service: RecallService, flags: Record<string, string | boolean>): Promise<void> {
  const status = service.getProjectsStatus();
  
  if (status.length === 0) {
    console.log('No projects found.');
    return;
  }
  
  // JSON output
  if (flags.format === 'json') {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  
  // Human readable
  console.log(`Project Status (${status.length} projects):\n`);
  
  for (const proj of status) {
    console.log(`${proj.display_name || proj.project_id}`);
    console.log('─'.repeat(60));
    
    if (proj.last_user_message) {
      const time = formatDate(proj.last_user_message.ts);
      const text = truncate(proj.last_user_message.text, 60);
      console.log(`  Last message:   ${time}`);
      console.log(`                  "${text}"`);
    } else {
      console.log(`  Last message:   (none)`);
    }
    
    if (proj.last_git_commit) {
      const time = formatDate(proj.last_git_commit.ts);
      const msg = truncate(proj.last_git_commit.message.split('\n')[0], 50);
      console.log(`  Last commit:    ${time}`);
      console.log(`                  ${proj.last_git_commit.sha.slice(0, 7)} - ${msg}`);
    } else {
      console.log(`  Last commit:    (none)`);
    }
    
    if (proj.last_tool_call) {
      const time = formatDate(proj.last_tool_call.ts);
      console.log(`  Last tool:      ${time} (${proj.last_tool_call.tool})`);
    }
    
    console.log('');
  }
}

async function cmdSourcesList(service: RecallService): Promise<void> {
  const sources = service.listSources();
  
  if (sources.length === 0) {
    console.log('No sources registered.');
    console.log('Run: recall sources add claude-code');
    return;
  }
  
  console.log('Sources:');
  for (const source of sources) {
    const statusIcon = source.status === 'active' ? '[OK]' : source.status === 'missing' ? '[?]' : '[!]';
    console.log(`  ${statusIcon} ${source.kind}`);
    console.log(`      ${source.locator}`);
    console.log(`      ID: ${source.source_id.slice(0, 8)}...`);
  }
}



async function cmdSourcesAdd(service: RecallService, type: string, flags: Record<string, string | boolean>): Promise<void> {
  if (type === 'claude-code' || type === 'claude_code') {
    const { claudeSources, gitSources, workingDirs } = await service.addClaudeCodeSource();
    
    if (claudeSources.length === 0) {
      console.log('No Claude Code session files found.');
      console.log('Expected location: ~/.claude/projects/');
      return;
    }
    
    console.log(`Added ${claudeSources.length} Claude Code source(s)`);
    
    // Show all discovered projects
    if (workingDirs.length > 0) {
      console.log(`\nDiscovered ${workingDirs.length} project(s):`);
      const gitDirs = new Set(gitSources.map(s => s.locator));
      for (const dir of workingDirs) {
        const hasGit = gitDirs.has(dir);
        const marker = hasGit ? '[git]' : '[no git]';
        console.log(`  ${marker} ${dir}`);
      }
    }
    
    // Trigger initial ingestion
    console.log('\nIngesting...');
    const results = await service.ingestAll();
    const totalEvents = results.reduce((sum, r) => sum + r.eventsCreated, 0);
    console.log(`Ingested ${totalEvents} events.`);
  } else if (type === 'opencode' || type === 'open-code') {
    const { sessionSources, gitSources, workingDirs } = await service.addOpenCodeSource();
    
    if (sessionSources.length === 0) {
      console.log('No OpenCode sessions found.');
      console.log('Expected location: ~/.local/share/opencode/storage/');
      return;
    }
    
    console.log(`Added ${sessionSources.length} OpenCode session(s)`);
    
    // Show all discovered projects
    if (workingDirs.length > 0) {
      console.log(`\nDiscovered ${workingDirs.length} project(s):`);
      const gitDirs = new Set(gitSources.map(s => s.locator));
      for (const dir of workingDirs) {
        const hasGit = gitDirs.has(dir);
        const marker = hasGit ? '[git]' : '[no git]';
        console.log(`  ${marker} ${dir}`);
      }
    }
    
    // Trigger initial ingestion
    console.log('\nIngesting...');
    const results = await service.ingestAll();
    const totalEvents = results.reduce((sum, r) => sum + r.eventsCreated, 0);
    console.log(`Ingested ${totalEvents} events.`);
  } else if (type === 'cursor') {
    const { transcriptSources, gitSources, workingDirs } = await service.addCursorSource();
    
    if (transcriptSources.length === 0) {
      console.log('No Cursor agent transcripts found.');
      console.log('Expected location: ~/.cursor/projects/');
      console.log('(Only Cursor agent mode is supported.)');
      return;
    }
    
    console.log(`Added ${transcriptSources.length} Cursor agent transcript(s)`);
    
    // Show all discovered projects
    if (workingDirs.length > 0) {
      console.log(`\nDiscovered ${workingDirs.length} project(s) from agent transcripts:`);
      const gitDirs = new Set(gitSources.map(s => s.locator));
      for (const dir of workingDirs) {
        const hasGit = gitDirs.has(dir);
        const marker = hasGit ? '[git]' : '[no git]';
        console.log(`  ${marker} ${dir}`);
      }
    }
    
    // Trigger initial ingestion
    console.log('\nIngesting...');
    const results = await service.ingestAll();
    const totalEvents = results.reduce((sum, r) => sum + r.eventsCreated, 0);
    console.log(`Ingested ${totalEvents} events.`);
  } else if (type === 'git') {
    const dir = flags.dir ? String(flags.dir) : process.cwd();
    
    try {
      const source = service.addGitSource(dir);
      console.log(`Added git source: ${source.locator}`);
      
      // Trigger initial ingestion
      console.log('\nIngesting...');
      const result = await service.ingestSource(source);
      console.log(`Ingested ${result.eventsCreated} events (${result.linesProcessed} commits/branches).`);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  } else {
    console.error(`Unknown source type: ${type}`);
    console.log('Supported types: claude-code, opencode, git');
    process.exit(1);
  }
}

async function cmdSourcesRemove(service: RecallService, sourceId: string, purge: boolean): Promise<void> {
  service.removeSource(sourceId, purge);
  console.log(`Removed source ${sourceId}`);
  if (purge) {
    console.log('Events from this source have been purged.');
  }
}

async function cmdIngest(service: RecallService): Promise<void> {
  console.log('Ingesting from all sources...');
  const results = await service.ingestAll();
  
  let totalLines = 0;
  let totalEvents = 0;
  
  for (const result of results) {
    totalLines += result.linesProcessed;
    totalEvents += result.eventsCreated;
    
    if (result.eventsCreated > 0) {
      console.log(`  ${result.filePath}: +${result.eventsCreated} events`);
    }
    
    for (const error of result.errors) {
      console.error(`  Error: ${error}`);
    }
  }
  
  console.log(`\nProcessed ${totalLines} lines, created ${totalEvents} events.`);
}

async function cmdSearch(service: RecallService, query: string, flags: Record<string, string | boolean>): Promise<void> {
  const limit = flags.limit ? parseInt(String(flags.limit), 10) : 10;
  const offset = flags.offset ? parseInt(String(flags.offset), 10) : 0;
  
  // Resolve project: --cwd uses current directory, --project uses provided value
  let projectId: string | undefined;
  if (flags.cwd) {
    const cwdProject = service.getProjectByPath(process.cwd());
    projectId = cwdProject?.project_id;
  } else if (flags.project) {
    projectId = String(flags.project);
  }
  
  const request = {
    query,
    limit,
    offset,
    project_id: projectId,
    session_id: flags.session ? String(flags.session) : undefined,
    event_types: flags.type ? [String(flags.type) as EventType] : undefined,
    tool_names: flags.tool ? [String(flags.tool)] : undefined,
    role: flags.role ? String(flags.role) as MessageRole : undefined,
    since: flags.since ? parseRelativeTime(String(flags.since)) : undefined,
    until: flags.until ? parseRelativeTime(String(flags.until)) : undefined,
  };
  
  const response = service.search(request);
  
  // Build base command for pagination
  const baseArgs = ['recall search', `"${query}"`];
  if (flags.type) baseArgs.push(`--type ${flags.type}`);
  if (flags.tool) baseArgs.push(`--tool ${flags.tool}`);
  if (flags.role) baseArgs.push(`--role ${flags.role}`);
  if (flags.project) baseArgs.push(`--project ${flags.project}`);
  if (flags.session) baseArgs.push(`--session ${flags.session}`);
  if (flags.since) baseArgs.push(`--since "${flags.since}"`);
  if (flags.until) baseArgs.push(`--until "${flags.until}"`);
  if (flags.limit) baseArgs.push(`--limit ${flags.limit}`);
  baseArgs.push('--format json');
  const baseCommand = baseArgs.join(' ');
  
  // JSON output format with pagination
  if (flags.format === 'json') {
    const pagination = buildPagination(offset, limit, response.results.length, response.total, baseCommand);
    // Rename text_redacted to text for cleaner output
    const results = response.results.map(r => ({
      ...r,
      text: r.text_redacted,
      text_redacted: undefined,
    }));
    console.log(JSON.stringify({
      results,
      pagination,
      timing: response.timing,
    }, null, 2));
    return;
  }
  
  // JSONL output format (one JSON object per line)
  if (flags.format === 'jsonl') {
    for (const result of response.results) {
      console.log(JSON.stringify(result));
    }
    return;
  }
  
  // CSV output format
  if (flags.format === 'csv') {
    console.log('event_ts,event_type,text_redacted,tool_name,project_id,session_id');
    for (const result of response.results) {
      const text = result.text_redacted.replace(/"/g, '""').replace(/\n/g, ' ');
      console.log(`"${result.event_ts}","${result.event_type}","${text}","${result.tool_name || ''}","${result.project_id || ''}","${result.session_id || ''}"`);
    }
    return;
  }
  
  // Default human-readable format
  if (response.results.length === 0) {
    console.log('No results found.');
    return;
  }
  
  console.log(`Found ${response.total} results (${response.timing.search_ms.toFixed(1)}ms):\n`);
  
  for (const result of response.results) {
    const time = formatDate(result.event_ts);
    const type = result.event_type.padEnd(18);
    const text = truncate(result.text_redacted.replace(/\n/g, ' '), 80);
    
    console.log(`${time}  ${type}  ${text}`);
    
    if (result.tool_name) {
      console.log(`  Tool: ${result.tool_name}`);
      
      if (result.tool_args_json) {
        try {
          const args = JSON.parse(result.tool_args_json);
          const argsStr = JSON.stringify(args);
          console.log(`  Args: ${truncate(argsStr, 100)}`);
        } catch {}
      }
    }
  }
  
  // Print pagination footer
  printPaginationFooter(offset, response.results.length, response.total, offset + response.results.length);
}

async function cmdTimeline(service: RecallService, flags: Record<string, string | boolean>): Promise<void> {
  // --last flag: show minimal summary of last activity
  if (flags.last) {
    const status = service.getProjectsStatus();
    
    // Filter by project if specified
    const projectFilter = flags.project ? String(flags.project) : null;
    const filteredStatus = projectFilter 
      ? status.filter(p => p.project_id === projectFilter || p.display_name === projectFilter)
      : status;
    
    if (filteredStatus.length === 0) {
      console.log(`No project found matching: ${projectFilter}`);
      return;
    }
    
    // Find most recent activity across filtered projects
    let lastMessage: any = null;
    let lastCommit: any = null;
    let lastTool: any = null;
    let activeProject = '';
    
    for (const proj of filteredStatus) {
      if (proj.last_user_message && (!lastMessage || new Date(proj.last_user_message.ts) > new Date(lastMessage.ts))) {
        lastMessage = { ...proj.last_user_message, project: proj.display_name };
      }
      if (proj.last_git_commit && (!lastCommit || new Date(proj.last_git_commit.ts) > new Date(lastCommit.ts))) {
        lastCommit = { ...proj.last_git_commit, project: proj.display_name };
      }
      if (proj.last_tool_call && (!lastTool || new Date(proj.last_tool_call.ts) > new Date(lastTool.ts))) {
        lastTool = { ...proj.last_tool_call, project: proj.display_name };
      }
    }
    
    // Determine most recent project
    const messageTime = lastMessage ? new Date(lastMessage.ts).getTime() : 0;
    const commitTime = lastCommit ? new Date(lastCommit.ts).getTime() : 0;
    const toolTime = lastTool ? new Date(lastTool.ts).getTime() : 0;
    const mostRecent = Math.max(messageTime, commitTime, toolTime);
    
    if (mostRecent === messageTime) activeProject = lastMessage.project;
    else if (mostRecent === commitTime) activeProject = lastCommit.project;
    else if (mostRecent === toolTime) activeProject = lastTool.project;
    
    console.log(`Last activity: ${activeProject}`);
    
    if (lastMessage) {
      console.log(`  Last message: ${formatDate(lastMessage.ts)} (${lastMessage.project})`);
      console.log(`    "${truncate(lastMessage.text, 70)}"`);
    }
    
    if (lastCommit) {
      console.log(`  Last commit:  ${formatDate(lastCommit.ts)} (${lastCommit.project})`);
      console.log(`    ${lastCommit.sha.slice(0, 7)} - ${truncate(lastCommit.message.split('\n')[0], 60)}`);
    }
    
    if (lastTool) {
      console.log(`  Last tool:    ${formatDate(lastTool.ts)} (${lastTool.project})`);
      console.log(`    ${lastTool.tool}`);
      if (lastTool.file_paths && lastTool.file_paths.length > 0) {
        const shown = lastTool.file_paths.slice(0, 3).join(', ');
        const more = lastTool.file_paths.length > 3 ? ` (+${lastTool.file_paths.length - 3} more)` : '';
        console.log(`    Files: ${shown}${more}`);
      }
    }
    
    if (!lastMessage && !lastCommit && !lastTool) {
      console.log('  No recent activity found.');
    }
    
    return;
  }
  
  // Default to 2h, or no limit if --all/--session, or specific date if --date
  // When --session is specified, default to all time (user wants that specific session)
  let since: string | undefined;
  let until: string | undefined = flags.until ? parseRelativeTime(String(flags.until)) : undefined;
  
  if (flags.all || flags.session) {
    since = undefined;
  } else if (flags.date) {
    since = parseRelativeTime(String(flags.date));
    until = parseRelativeTime(String(flags.date) + ' 23:59:59');
  } else if (flags.since) {
    since = parseRelativeTime(String(flags.since));
  } else {
    since = parseRelativeTime('2 hours ago');
  }
  
  const limit = flags.limit ? parseInt(String(flags.limit), 10) : 10;  // Default 10, not 50
  const offset = flags.offset ? parseInt(String(flags.offset), 10) : 0;
  
  // Resolve project: --cwd uses current directory, --project uses provided value
  let projectId: string | undefined;
  if (flags.cwd) {
    const cwdProject = service.getProjectByPath(process.cwd());
    projectId = cwdProject?.project_id;
  } else if (flags.project) {
    projectId = String(flags.project);
  }
  
  const request = {
    since,
    until,
    limit,
    offset,
    project_id: projectId,
    session_id: flags.session ? String(flags.session) : undefined,
    tool_names: flags.tool ? [String(flags.tool)] : undefined,
    event_types: flags.type ? [String(flags.type) as EventType] : undefined,
    role: flags.role ? String(flags.role) as MessageRole : undefined,
    include_git: flags['no-git'] ? false : true,
  };
  
  const response = service.timeline(request);
  
  // Build base command for pagination
  const baseArgs = ['recall timeline'];
  if (flags.since) baseArgs.push(`--since "${flags.since}"`);
  if (flags.until) baseArgs.push(`--until "${flags.until}"`);
  if (flags.type) baseArgs.push(`--type ${flags.type}`);
  if (flags.tool) baseArgs.push(`--tool ${flags.tool}`);
  if (flags.role) baseArgs.push(`--role ${flags.role}`);
  if (flags.project) baseArgs.push(`--project ${flags.project}`);
  if (flags.session) baseArgs.push(`--session ${flags.session}`);
  if (flags['no-git']) baseArgs.push('--no-git');
  if (flags.limit) baseArgs.push(`--limit ${flags.limit}`);
  baseArgs.push('--format json');
  const baseCommand = baseArgs.join(' ');
  
  // JSON output format with pagination
  if (flags.format === 'json') {
    const pagination = buildPagination(offset, limit, response.events.length, response.total, baseCommand);
    console.log(JSON.stringify({
      events: response.events,
      pagination,
      summary: response.summary,
    }, null, 2));
    return;
  }
  
  // JSONL output format
  if (flags.format === 'jsonl') {
    for (const event of response.events) {
      console.log(JSON.stringify(event));
    }
    return;
  }
  
  // CSV output format
  if (flags.format === 'csv') {
    console.log('event_ts,event_type,text_redacted,tool_name,git_sha,git_insertions,git_deletions');
    for (const event of response.events) {
      const text = event.text_redacted.replace(/"/g, '""').replace(/\n/g, ' ');
      console.log(`"${event.event_ts}","${event.event_type}","${text}","${event.tool_name || ''}","${event.git_sha || ''}","${event.git_insertions || ''}","${event.git_deletions || ''}"`);
    }
    return;
  }
  
  // Default human-readable format
  if (response.events.length === 0) {
    console.log('No events in this time range.');
    return;
  }
  
  console.log(`Timeline (${response.summary.total_events} events)`);
  console.log('─'.repeat(60));
  
  for (const event of response.events) {
    const time = formatTime(event.event_ts);
    const type = getEventIcon(event.event_type);
    const text = truncate(event.text_redacted.replace(/\n/g, ' '), 60);
    
    console.log(`${time}  ${type}  ${text}`);
    
    if (event.tool_name) {
      console.log(`         Tool: ${event.tool_name}`);
      
      if (event.tool_args_json) {
        try {
          const args = JSON.parse(event.tool_args_json);
          const argsStr = JSON.stringify(args);
          console.log(`         Args: ${truncate(argsStr, 80)}`);
        } catch {}
      }
    }
    
    if (event.git_sha) {
      console.log(`         Commit: ${event.git_sha}`);
      if (event.git_insertions !== undefined || event.git_deletions !== undefined) {
        console.log(`         Changes: +${event.git_insertions || 0} -${event.git_deletions || 0}`);
      }
    }
  }
  
  console.log('─'.repeat(60));
  console.log(`Summary: ${response.summary.total_events} events`);
  
  if (response.summary.commits_count) {
    console.log(`  Commits: ${response.summary.commits_count}`);
  }
  if (response.summary.lines_added || response.summary.lines_removed) {
    console.log(`  Lines: +${response.summary.lines_added || 0} -${response.summary.lines_removed || 0}`);
  }
  
  // Print pagination footer
  printPaginationFooter(offset, response.events.length, response.total, offset + response.events.length);
}

async function cmdFile(service: RecallService, filePath: string, flags: Record<string, string | boolean>): Promise<void> {
  // Parse line range if provided (file.ts:50-100 or file.ts:50)
  let actualPath = filePath;
  let lineStart: number | undefined;
  let lineEnd: number | undefined;
  
  const rangeMatch = filePath.match(/^(.+):(\d+)(?:-(\d+))?$/);
  if (rangeMatch) {
    actualPath = rangeMatch[1];
    lineStart = parseInt(rangeMatch[2], 10);
    lineEnd = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : undefined;
  }
  
  // Override with flags if provided
  if (flags.offset) {
    lineStart = parseInt(String(flags.offset), 10);
  }
  if (flags.limit) {
    const limit = parseInt(String(flags.limit), 10);
    lineEnd = (lineStart ?? 1) + limit - 1;
  }
  
  // Get file content at specific time or latest
  const before = flags.at ? parseRelativeTime(String(flags.at)) : undefined;
  
  const result = service.getFileContent(actualPath, before);
  
  if (!result) {
    console.error(`No content found for: ${actualPath}`);
    console.log('The file may not have been read by any agent, or the path may be incorrect.');
    process.exit(1);
  }
  
  // Check staleness - how old is this snapshot?
  const snapshotAge = Date.now() - new Date(result.event_ts).getTime();
  const ageMinutes = Math.floor(snapshotAge / 60000);
  const ageHours = Math.floor(ageMinutes / 60);
  const ageDays = Math.floor(ageHours / 24);
  
  let ageStr: string;
  let isStale = false;
  if (ageDays > 0) {
    ageStr = `${ageDays}d ago`;
    isStale = true;
  } else if (ageHours > 0) {
    ageStr = `${ageHours}h ago`;
    isStale = ageHours > 1;
  } else {
    ageStr = `${ageMinutes}m ago`;
  }
  
  // Check if file still exists and get current line count
  let fileStatus: 'current' | 'changed' | 'deleted' = 'current';
  let currentLineCount: number | null = null;
  try {
    const fs = await import('fs');
    const currentContent = fs.readFileSync(actualPath, 'utf-8');
    currentLineCount = currentContent.split('\n').length;
    const snapshotLineCount = result.content.split('\n').length;
    if (currentContent !== result.content) {
      fileStatus = 'changed';
    }
  } catch {
    fileStatus = 'deleted';
  }
  
  // JSON output
  if (flags.format === 'json') {
    const lines = result.content.split('\n');
    const output: Record<string, any> = {
      file_path: actualPath,
      snapshot_ts: result.event_ts,
      snapshot_age: ageStr,
      file_status: fileStatus,
      tool_name: result.tool_name,
      event_id: result.event_id,
      total_lines: lines.length,
      line_start: lineStart ?? 1,
      line_end: lineEnd ?? lines.length,
      content: getLineSlice(result.content, lineStart, lineEnd),
    };
    
    // Add current line count if file still exists and changed
    if (fileStatus === 'changed' && currentLineCount !== null) {
      output.current_line_count = currentLineCount;
    }
    
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  
  // Human readable output
  const lines = result.content.split('\n');
  const totalLines = lines.length;
  const start = (lineStart ?? 1) - 1;  // Convert to 0-indexed
  const end = lineEnd ?? totalLines;
  
  const slicedLines = lines.slice(start, end);
  
  // Header with status
  console.log(`File: ${actualPath}`);
  console.log(`Snapshot: ${formatDate(result.event_ts)} (${ageStr}) via ${result.tool_name}`);
  if (fileStatus === 'deleted') {
    console.log(`Status: deleted`);
  } else if (fileStatus === 'changed') {
    console.log(`Status: changed (now ${currentLineCount} lines)`);
  }
  console.log(`Lines: ${start + 1}-${Math.min(end, totalLines)} of ${totalLines}`);
  console.log('─'.repeat(60));
  
  // Print lines with line numbers
  slicedLines.forEach((line: string, idx: number) => {
    const lineNum = String(start + idx + 1).padStart(5, ' ');
    console.log(`${lineNum} │ ${line}`);
  });
  
  // Footer with navigation hints
  console.log('─'.repeat(60));
  if (end < totalLines) {
    console.log(`More: recall file "${actualPath}" --offset ${end + 1} --limit 50`);
  }
}

async function cmdFileHistory(service: RecallService, filePath: string, flags: Record<string, string | boolean>): Promise<void> {
  const history = service.getFileHistory(filePath, {
    since: flags.since ? parseRelativeTime(String(flags.since)) : undefined,
    until: flags.until ? parseRelativeTime(String(flags.until)) : undefined,
    limit: flags.limit ? parseInt(String(flags.limit), 10) : 20,
  });
  
  // Also get edits for this file
  const edits = service.getEdits({
    file_path: filePath,
    since: flags.since ? parseRelativeTime(String(flags.since)) : undefined,
    until: flags.until ? parseRelativeTime(String(flags.until)) : undefined,
    limit: flags.limit ? parseInt(String(flags.limit), 10) : 20,
  });
  
  if (history.length === 0 && edits.length === 0) {
    console.log(`No history found for: ${filePath}`);
    return;
  }
  
  // JSON output
  if (flags.format === 'json') {
    console.log(JSON.stringify({ history, edits }, null, 2));
    return;
  }
  
  // Merge and sort by timestamp
  const allEvents: Array<{
    event_ts: string;
    type: 'read' | 'edit';
    tool_name: string;
    line_count?: number;
    old_lines?: number;
    new_lines?: number;
    event_id: string;
  }> = [];
  
  for (const h of history) {
    allEvents.push({
      event_ts: h.event_ts,
      type: 'read',
      tool_name: h.tool_name,
      line_count: h.line_count,
      event_id: h.event_id,
    });
  }
  
  for (const e of edits) {
    allEvents.push({
      event_ts: e.event_ts,
      type: 'edit',
      tool_name: 'Edit',
      old_lines: e.old_string.split('\n').length,
      new_lines: e.new_string.split('\n').length,
      event_id: e.event_id,
    });
  }
  
  // Sort by time
  allEvents.sort((a, b) => new Date(a.event_ts).getTime() - new Date(b.event_ts).getTime());
  
  // Human readable
  console.log(`File: ${filePath}`);
  console.log(`History (${allEvents.length} versions):\n`);
  
  for (const event of allEvents) {
    const time = formatDate(event.event_ts);
    if (event.type === 'read') {
      console.log(`${time}  [${event.tool_name}]  ${event.line_count} lines`);
    } else {
      const oldLines = event.old_lines || 0;
      const newLines = event.new_lines || 0;
      const diff = newLines - oldLines;
      const diffStr = diff >= 0 ? `+${diff}` : `${diff}`;
      console.log(`${time}  [Edit]  ${diffStr} lines (${oldLines} → ${newLines})`);
    }
  }
  
  console.log('');
  console.log('View specific version:');
  console.log(`  recall file "${filePath}" --at "<timestamp>"`);
  console.log('');
  console.log('Compare versions (coming soon):');
  console.log(`  recall file-diff "${filePath}" --from "<time>" --to "<time>"`);
}

async function cmdHistory(service: RecallService, flags: Record<string, string | boolean>): Promise<void> {
  // Default to 7d, or no limit if --all/--session, or specific date if --date
  // When --session is specified, default to all time (user wants that specific session)
  let since: string | undefined;
  let until: string | undefined = flags.until ? parseRelativeTime(String(flags.until)) : undefined;
  
  if (flags.all || flags.session) {
    since = undefined;
  } else if (flags.date) {
    since = parseRelativeTime(String(flags.date));
    until = parseRelativeTime(String(flags.date) + ' 23:59:59');
  } else if (flags.since) {
    since = parseRelativeTime(String(flags.since));
  } else {
    since = parseRelativeTime('7 days ago');
  }
  
  const limit = flags.limit ? parseInt(String(flags.limit), 10) : 10;  // Default 10, not 50
  const offset = flags.offset ? parseInt(String(flags.offset), 10) : 0;
  
  // Use timeline but filter to user_message only
  const response = service.timeline({
    since,
    until,
    event_types: ['user_message'],
    project_id: flags.project ? String(flags.project) : undefined,
    session_id: flags.session ? String(flags.session) : undefined,
    limit,
    offset,
  });
  
  // Build base command for pagination
  const baseArgs = ['recall history'];
  if (flags.since) baseArgs.push(`--since "${flags.since}"`);
  if (flags.until) baseArgs.push(`--until "${flags.until}"`);
  if (flags.project) baseArgs.push(`--project ${flags.project}`);
  if (flags.session) baseArgs.push(`--session ${flags.session}`);
  if (flags.limit) baseArgs.push(`--limit ${flags.limit}`);
  if (flags.full) baseArgs.push('--full');
  baseArgs.push('--format json');
  const baseCommand = baseArgs.join(' ');
  
  if (response.events.length === 0) {
    console.log('No user messages found in this time range.');
    return;
  }
  
  // JSON output with pagination
  if (flags.format === 'json') {
    const pagination = buildPagination(offset, limit, response.events.length, response.total, baseCommand);
    console.log(JSON.stringify({
      events: response.events,
      pagination,
    }, null, 2));
    return;
  }
  
  // JSONL output  
  if (flags.format === 'jsonl') {
    for (const event of response.events) {
      console.log(JSON.stringify(event));
    }
    return;
  }
  
  // Human readable - show conversation history
  console.log(`Your requests (${response.total} total):\n`);
  
  for (const event of response.events) {
    const time = formatDate(event.event_ts);
    // For user messages, show more context
    const text = flags.full 
      ? event.text_redacted 
      : truncate(event.text_redacted.replace(/\n/g, ' '), 100);
    
    console.log(`${time}`);
    console.log(`  ${text}`);
    console.log('');
  }
  
  // Print pagination footer
  printPaginationFooter(offset, response.events.length, response.total, offset + response.events.length);
}

async function cmdConversation(service: RecallService, flags: Record<string, string | boolean>): Promise<void> {
  // Default to 1 day, or no limit if --all/--session, or specific date if --date
  // When --session is specified, default to all time (user wants that specific session)
  let since: string | undefined;
  if (flags.all || flags.session) {
    since = undefined;
  } else if (flags.date) {
    // Jump to specific date: --date 2026-01-07
    since = parseRelativeTime(String(flags.date));
  } else if (flags.since) {
    since = parseRelativeTime(String(flags.since));
  } else {
    since = parseRelativeTime('1 day ago');
  }
  const until = flags.until ? parseRelativeTime(String(flags.until)) : (flags.date ? parseRelativeTime(String(flags.date) + ' 23:59:59') : undefined);
  
  // Chunking support: --offset and --chunk-size
  const offset = flags.offset ? parseInt(String(flags.offset), 10) : 0;
  const chunkSize = flags['chunk-size'] ? parseInt(String(flags['chunk-size']), 10) : 20;
  
  // Tiered event types:
  // Default: just messages (lightweight)
  // --with-tools: messages + tool calls (full picture)
  // --tools-only: just tool calls
  let eventTypes: EventType[];
  let mode: 'messages' | 'full' | 'tools';
  
  if (flags['tools-only']) {
    eventTypes = ['tool_call'];
    mode = 'tools';
  } else if (flags['with-tools']) {
    eventTypes = ['user_message', 'assistant_message', 'tool_call'];
    mode = 'full';
  } else {
    eventTypes = ['user_message', 'assistant_message'];
    mode = 'messages';
  }
  
  // Use proper DB pagination
  const response = service.timeline({
    since,
    until,
    event_types: eventTypes,
    project_id: flags.project ? String(flags.project) : undefined,
    session_id: flags.session ? String(flags.session) : undefined,
    limit: chunkSize,
    offset,
  });
  
  if (response.events.length === 0 && offset === 0) {
    console.log('No conversation found in this time range.');
    return;
  }
  
  if (response.events.length === 0) {
    console.log(`No events at offset ${offset}. Total: ${response.total}`);
    return;
  }
  
  // Build base command for pagination
  const baseArgs = ['recall conversation'];
  if (flags.since) baseArgs.push(`--since "${flags.since}"`);
  if (flags.until) baseArgs.push(`--until "${flags.until}"`);
  if (flags.project) baseArgs.push(`--project ${flags.project}`);
  if (flags.session) baseArgs.push(`--session ${flags.session}`);
  if (flags['with-tools']) baseArgs.push('--with-tools');
  if (flags['tools-only']) baseArgs.push('--tools-only');
  if (flags['chunk-size']) baseArgs.push(`--chunk-size ${flags['chunk-size']}`);
  if (flags.full) baseArgs.push('--full');
  baseArgs.push('--format json');
  const baseCommand = baseArgs.join(' ');
  
  // JSON output - compact for agents with full pagination
  if (flags.format === 'json') {
    const compactEvents = response.events.map(e => {
      const event: any = {
        ts: e.event_ts,
        type: e.event_type === 'user_message' ? 'user' : e.event_type === 'assistant_message' ? 'assistant' : 'tool',
        text: e.text_redacted,
      };
      
      if (e.tool_name) {
        event.tool = e.tool_name;
      }
      
      if (e.tool_args_json) {
        try {
          event.tool_args = JSON.parse(e.tool_args_json);
        } catch {
          // If parsing fails, include as string
          event.tool_args_json = e.tool_args_json;
        }
      }
      
      if (e.file_paths && e.file_paths.length > 0) {
        event.files = e.file_paths;
      }
      
      return event;
    });
    const pagination = buildPagination(offset, chunkSize, response.events.length, response.total, baseCommand);
    console.log(JSON.stringify({
      events: compactEvents,
      pagination,
    }, null, 2));
    return;
  }
  
  // JSONL output  
  if (flags.format === 'jsonl') {
    for (const event of response.events) {
      const line: any = {
        ts: event.event_ts,
        type: event.event_type === 'user_message' ? 'user' : event.event_type === 'assistant_message' ? 'assistant' : 'tool',
        text: event.text_redacted,
      };
      
      if (event.tool_name) {
        line.tool = event.tool_name;
      }
      
      if (event.tool_args_json) {
        try {
          line.tool_args = JSON.parse(event.tool_args_json);
        } catch {
          line.tool_args_json = event.tool_args_json;
        }
      }
      
      console.log(JSON.stringify(line));
    }
    return;
  }
  
  // Human readable - show conversation flow
  const modeLabel = mode === 'full' ? ' + tools' : mode === 'tools' ? ' (tools only)' : '';
  const endIdx = offset + response.events.length;
  console.log(`Conversation${modeLabel} (${offset + 1}-${endIdx} of ${response.total}):\n`);
  
  for (const event of response.events) {
    const time = formatDate(event.event_ts);
    let prefix: string;
    let text: string;
    
    if (event.event_type === 'user_message') {
      prefix = '👤 USER';
      text = flags.full ? event.text_redacted : truncate(event.text_redacted.replace(/\n/g, ' '), 200);
    } else if (event.event_type === 'assistant_message') {
      prefix = '🤖 ASST';
      text = flags.full ? event.text_redacted : truncate(event.text_redacted.replace(/\n/g, ' '), 200);
    } else {
      prefix = `🔧 ${event.tool_name || 'TOOL'}`;
      // For tools, show args if available, otherwise files, otherwise text
      if (event.tool_args_json) {
        try {
          const args = JSON.parse(event.tool_args_json);
          const argsStr = JSON.stringify(args, null, 2);
          text = flags.full ? argsStr : truncate(argsStr.replace(/\n/g, ' '), 100);
        } catch {
          const files = event.file_paths?.join(', ') || '';
          text = files ? files : truncate(event.text_redacted.replace(/\n/g, ' '), 100);
        }
      } else {
        const files = event.file_paths?.join(', ') || '';
        text = files ? files : truncate(event.text_redacted.replace(/\n/g, ' '), 100);
      }
    }
    
    console.log(`${time}  ${prefix}`);
    console.log(`  ${text}`);
    console.log('');
  }
  
  // Show navigation hint with pagination footer
  printPaginationFooter(offset, response.events.length, response.total, endIdx);
}

async function cmdDiffs(service: RecallService, flags: Record<string, string | boolean>): Promise<void> {
  // Default to 24h, or no limit if --session is specified (user wants that specific session)
  const since = flags.session ? undefined : (flags.since ? parseRelativeTime(String(flags.since)) : parseRelativeTime('24 hours ago'));
  const until = flags.until ? parseRelativeTime(String(flags.until)) : undefined;
  
  const diffs = service.getEdits({
    since,
    until,
    project_id: flags.project ? String(flags.project) : undefined,
    session_id: flags.session ? String(flags.session) : undefined,
    file_path: flags.file ? String(flags.file) : undefined,
    limit: flags.limit ? parseInt(String(flags.limit), 10) : 20,
  });
  
  if (diffs.length === 0) {
    console.log('No edits found in this time range.');
    console.log('Edit tool calls contain oldString/newString diffs.');
    return;
  }
  
  // JSON output
  if (flags.format === 'json') {
    console.log(JSON.stringify(diffs, null, 2));
    return;
  }
  
  // Human readable
  console.log(`Edits (${diffs.length}):\n`);
  
  for (const diff of diffs) {
    const time = formatDate(diff.event_ts);
    console.log(`${time}  ${diff.file_path}`);
    console.log('─'.repeat(60));
    
    // Show old content (red/removed)
    const oldLines = diff.old_string.split('\n');
    for (const line of oldLines) {
      console.log(`- ${line}`);
    }
    
    // Show new content (green/added)  
    const newLines = diff.new_string.split('\n');
    for (const line of newLines) {
      console.log(`+ ${line}`);
    }
    
    console.log('');
  }
}

async function cmdReconstruct(service: RecallService, filePath: string, flags: Record<string, string | boolean>): Promise<void> {
  const until = flags.at ? parseRelativeTime(String(flags.at)) : undefined;
  
  if (!until) {
    console.error('Error: --at <time> is required');
    console.error('Example: recall reconstruct /path/to/file.tsx --at "2026-01-11T01:00:00"');
    process.exit(1);
  }
  
  const outputPath = flags.output ? String(flags.output) : undefined;
  
  // STRATEGY 1: Try to find a Read tool result with full file content (fastest)
  console.error(`Looking for Read tool result...`);
  const read = service.findReadResult(filePath, until);
  
  if (read) {
    console.error(`✓ Found Read at ${read.event_ts} (${read.content.length} bytes)`);
    
    if (outputPath) {
      writeFileSync(outputPath, read.content);
      console.error(`✓ Saved to: ${outputPath}`);
    } else {
      console.log(read.content);
    }
    return;
  }
  
  console.error(`No Read found, reconstructing from Edit history...`);
  
  // STRATEGY 2: Reconstruct from Edit tool calls
  const diffs = service.getEdits({
    file_path: filePath,
    until,
    session_id: flags.session ? String(flags.session) : undefined,
    limit: 10000,
  });
  
  if (diffs.length === 0) {
    console.error(`No edits found for ${filePath} before ${until}`);
    process.exit(1);
  }
  
  diffs.sort((a, b) => new Date(a.event_ts).getTime() - new Date(b.event_ts).getTime());
  
  console.error(`Found ${diffs.length} edits, applying...`);
  
  let content = diffs[0].old_string || '';
  let applied = 0;
  let failed = 0;
  
  for (let i = 0; i < diffs.length; i++) {
    const diff = diffs[i];
    const oldStr = diff.old_string;
    const newStr = diff.new_string;
    
    if (!oldStr || !newStr) continue;
    
    if (content.includes(oldStr)) {
      content = content.replace(oldStr, newStr);
      applied++;
      if (flags.verbose) {
        console.error(`[${i + 1}/${diffs.length}] ✓ ${oldStr.length} → ${newStr.length}`);
      }
    } else {
      failed++;
      if (flags.verbose) {
        console.error(`[${i + 1}/${diffs.length}] ✗ oldString not found`);
      }
    }
  }
  
  console.error(`✓ Reconstructed: ${applied}/${diffs.length} edits, ${content.length} bytes`);
  
  if (outputPath) {
    writeFileSync(outputPath, content);
    console.error(`✓ Saved to: ${outputPath}`);
  } else {
    console.log(content);
  }
}

async function cmdFiles(service: RecallService, flags: Record<string, string | boolean>): Promise<void> {
  const files = service.listFiles({
    since: flags.since ? parseRelativeTime(String(flags.since)) : undefined,
    until: flags.until ? parseRelativeTime(String(flags.until)) : undefined,
    project_id: flags.project ? String(flags.project) : undefined,
    pattern: flags.pattern ? String(flags.pattern) : undefined,
    limit: flags.limit ? parseInt(String(flags.limit), 10) : 50,
  });
  
  if (files.length === 0) {
    console.log('No files found.');
    return;
  }
  
  // JSON output
  if (flags.format === 'json') {
    console.log(JSON.stringify(files, null, 2));
    return;
  }
  
  // Human readable
  console.log(`Files accessed (${files.length}):\n`);
  
  for (const file of files) {
    const time = formatDate(file.last_accessed);
    const tools = file.tools_used.join(', ');
    console.log(`${time}  ${file.file_path}`);
    console.log(`  Accessed ${file.access_count}x via: ${tools}`);
  }
}

/**
 * Show token usage statistics
 */
async function cmdStats(service: RecallService, flags: Record<string, string | boolean>): Promise<void> {
  const since = flags.since ? parseRelativeTime(String(flags.since)) : parseRelativeTime('7 days ago');
  const until = flags.until ? parseRelativeTime(String(flags.until)) : undefined;
  
  const tier = flags.tier ? String(flags.tier) : 'standard';
  if (tier !== 'standard' && tier !== 'priority') {
    console.error('Invalid --tier. Use: standard | priority');
    process.exit(1);
  }

  const stats = service.getTokenStats({
    since,
    until,
    project_id: flags.project ? String(flags.project) : undefined,
    session_id: flags.session ? String(flags.session) : undefined,
    group_by: flags['by-day'] ? 'day' : flags['by-session'] ? 'session' : flags['by-model'] ? 'model' : 'day',
    pricing_tier: tier as 'standard' | 'priority',
  });
  
  // Format large numbers
  const fmt = (n: number) => n.toLocaleString();
  
  // JSON output
  if (flags.format === 'json') {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }
  
  // Format cost
  const fmtCost = (n: number) => `$${n.toFixed(2)}`;
  
  // Human readable
  console.log(`Token Usage (since ${formatDate(since)}):\n`);
  
  console.log('TOTAL:');
  console.log(`  Input:       ${fmt(stats.total.input)}`);
  console.log(`  Output:      ${fmt(stats.total.output)}`);
  console.log(`  Reasoning:   ${fmt((stats.total as any).reasoning || 0)}  (billed as output)`);
  console.log(`  Cache Read:  ${fmt(stats.total.cache_read)}`);
  console.log(`  Cache Write: ${fmt(stats.total.cache_write)}`);
  console.log(`  ─────────────────────`);
  console.log(`  TOTAL:       ${fmt(stats.total.input + stats.total.output + stats.total.cache_read + stats.total.cache_write)}`);
  console.log(`  COST:        ${fmtCost(stats.total.cost_usd)}`);
  console.log('');
  
  if (stats.by_day && Object.keys(stats.by_day).length > 0) {
    console.log('BY DAY:');
    const days = Object.entries(stats.by_day).sort((a, b) => b[0].localeCompare(a[0])); // newest first
    for (const [day, tokens] of days.slice(0, 10)) { // show last 10 days
      const total = tokens.input + tokens.output + tokens.cache_read + tokens.cache_write;
      console.log(`  ${day}: ${fmt(total)} tokens, ${fmtCost(tokens.cost_usd)}`);
    }
    console.log('');
  }
  
  if (stats.by_model && Object.keys(stats.by_model).length > 0) {
    console.log('BY MODEL:');
    const models = Object.entries(stats.by_model).sort((a, b) => b[1].cost_usd - a[1].cost_usd); // by cost
    for (const [model, tokens] of models) {
      const total = tokens.input + tokens.output;
      console.log(`  ${model}: ${fmt(total)} tokens, ${fmtCost(tokens.cost_usd)}`);
    }
  }
}

/**
 * Show errors (linter, build, test failures, etc.)
 */
/**
 * Show events around a specific timestamp
 */
async function cmdAround(service: RecallService, flags: Record<string, string | boolean>): Promise<void> {
  // Get timestamp from positional arg or --at flag
  const timestamp = flags.at ? String(flags.at) : undefined;
  
  if (!timestamp) {
    console.error('Usage: recall around --at <timestamp> [--window <minutes>]');
    console.log('Example: recall around --at "2026-01-09T17:50:00Z" --window 30');
    console.log('Example: recall around --at "2h ago" --window 60');
    process.exit(1);
  }
  
  // Parse the timestamp
  const centerTime = parseRelativeTime(timestamp);
  const centerMs = new Date(centerTime).getTime();
  
  // Window in minutes (default 30)
  const windowMinutes = flags.window ? parseInt(String(flags.window), 10) : 30;
  const windowMs = windowMinutes * 60 * 1000;
  
  // Calculate since/until
  const since = new Date(centerMs - windowMs).toISOString();
  const until = new Date(centerMs + windowMs).toISOString();
  
  const limit = flags.limit ? parseInt(String(flags.limit), 10) : 50;
  const offset = flags.offset ? parseInt(String(flags.offset), 10) : 0;
  
  // Get events in this window
  const response = service.timeline({
    since,
    until,
    limit,
    offset,
    project_id: flags.project ? String(flags.project) : undefined,
    session_id: flags.session ? String(flags.session) : undefined,
  });
  
  // Build base command for pagination
  const baseArgs = ['recall around', `--at "${timestamp}"`];
  if (flags.window) baseArgs.push(`--window ${flags.window}`);
  if (flags.project) baseArgs.push(`--project ${flags.project}`);
  if (flags.session) baseArgs.push(`--session ${flags.session}`);
  if (flags.limit) baseArgs.push(`--limit ${flags.limit}`);
  baseArgs.push('--format json');
  const baseCommand = baseArgs.join(' ');
  
  // JSON output
  if (flags.format === 'json') {
    const pagination = buildPagination(offset, limit, response.events.length, response.total, baseCommand);
    console.log(JSON.stringify({
      center_timestamp: centerTime,
      window_minutes: windowMinutes,
      since,
      until,
      events: response.events,
      pagination,
    }, null, 2));
    return;
  }
  
  // Human readable
  if (response.events.length === 0) {
    console.log(`No events found within ${windowMinutes} minutes of ${formatDate(centerTime)}`);
    return;
  }
  
  console.log(`Events around ${formatDate(centerTime)} (+/- ${windowMinutes} min):`);
  console.log(`Window: ${formatDate(since)} to ${formatDate(until)}`);
  console.log('─'.repeat(60));
  
  for (const event of response.events) {
    const time = formatTime(event.event_ts);
    const type = getEventIcon(event.event_type);
    const text = truncate(event.text_redacted.replace(/\n/g, ' '), 60);
    
    // Highlight if this event is closest to center
    const eventMs = new Date(event.event_ts).getTime();
    const isNearCenter = Math.abs(eventMs - centerMs) < 60000; // within 1 minute
    const marker = isNearCenter ? '>>>' : '   ';
    
    console.log(`${marker} ${time}  ${type}  ${text}`);
    
    if (event.tool_name) {
      console.log(`         Tool: ${event.tool_name}`);
    }
  }
  
  console.log('─'.repeat(60));
  printPaginationFooter(offset, response.events.length, response.total, offset + response.events.length);
}

/**
 * Topics command: clusters search results by session/time to show distinct conversations
 * Helps agent disambiguate when a query matches multiple distinct issues
 */
async function cmdTopics(service: RecallService, query: string, flags: Record<string, string | boolean>): Promise<void> {
  if (!query) {
    console.error('Usage: recall topics "query" [--cwd] [--project X] [--format json]');
    process.exit(1);
  }
  
  // Resolve project
  let projectId: string | undefined;
  if (flags.cwd) {
    const cwdProject = service.getProjectByPath(process.cwd());
    projectId = cwdProject?.project_id;
  } else if (flags.project) {
    projectId = String(flags.project);
  }
  
  // Search with high limit to cluster
  const response = service.search({
    query,
    limit: 100,
    offset: 0,
    project_id: projectId,
    event_types: ['user_message'],
    since: flags.since ? parseRelativeTime(String(flags.since)) : undefined,
    until: flags.until ? parseRelativeTime(String(flags.until)) : undefined,
  });
  
  if (response.results.length === 0) {
    if (flags.format === 'json') {
      console.log(JSON.stringify({ query, topics: [], total: 0 }, null, 2));
    } else {
      console.log('No results found.');
    }
    return;
  }
  
  // Cluster by session + time gaps (>2h = new cluster)
  interface Topic {
    session_id: string;
    start: string;
    end: string;
    count: number;
    samples: string[];
  }
  
  const topics: Topic[] = [];
  let current: Topic | null = null;
  const GAP = 2 * 60 * 60 * 1000; // 2 hours
  
  const sorted = [...response.results].sort((a, b) => 
    new Date(a.event_ts).getTime() - new Date(b.event_ts).getTime()
  );
  
  for (const r of sorted) {
    const ts = new Date(r.event_ts).getTime();
    const sid = r.session_id || 'unknown';
    
    if (!current || current.session_id !== sid || ts - new Date(current.end).getTime() > GAP) {
      if (current) topics.push(current);
      current = { session_id: sid, start: r.event_ts, end: r.event_ts, count: 0, samples: [] };
    }
    
    current.end = r.event_ts;
    current.count++;
    
    if (current.samples.length < 2) {
      const text = r.text_redacted.replace(/\n/g, ' ').slice(0, 120);
      if (text.length > 15) current.samples.push(text);
    }
  }
  if (current) topics.push(current);
  
  // JSON output
  if (flags.format === 'json') {
    console.log(JSON.stringify({
      query,
      total: response.total,
      topics: topics.map(t => ({
        session_id: t.session_id,
        time: t.start.split('T')[0] + ' ' + t.start.split('T')[1]?.slice(0, 5),
        count: t.count,
        preview: t.samples[0] || '',
      })),
      hint: topics.length > 1 
        ? `Found ${topics.length} distinct conversations. Ask user which one or use --session.`
        : null,
    }, null, 2));
    return;
  }
  
  // Human output
  console.log(`Found ${response.total} results in ${topics.length} conversation(s):\n`);
  
  for (let i = 0; i < topics.length; i++) {
    const t = topics[i];
    const day = t.start.split('T')[0];
    const time = t.start.split('T')[1]?.slice(0, 5) || '';
    console.log(`[${i + 1}] ${day} ${time} - ${t.count} messages (${t.session_id.slice(0, 20)}...)`);
    if (t.samples[0]) console.log(`    "${truncate(t.samples[0], 80)}"`);
  }
  
  if (topics.length > 1) {
    console.log(`\nMultiple conversations found. Ask user which one, or use --session to filter.`);
  }
}

async function cmdErrors(service: RecallService, flags: Record<string, string | boolean>): Promise<void> {
  // Default to 7 days, or no limit if --all
  const since = flags.all ? undefined : (flags.since ? parseRelativeTime(String(flags.since)) : parseRelativeTime('7 days ago'));
  const limit = flags.limit ? parseInt(String(flags.limit), 10) : 50;
  const offset = flags.offset ? parseInt(String(flags.offset), 10) : 0;
  
  // Search for common error patterns in tool results
  // This covers: TypeScript errors, ESLint, test failures, build errors, runtime errors
  const errorPatterns = [
    'error', 'Error', 'ERROR',
    'failed', 'Failed', 'FAILED', 
    'failure', 'Failure',
    'TypeError', 'SyntaxError', 'ReferenceError',
    'Cannot find', 'cannot find',
    'is not defined', 'is not a function',
    'unexpected token', 'Unexpected token',
    'ENOENT', 'EACCES', 'EPERM',
    'npm ERR', 'yarn error',
    'tsc.*error', 'TS\\d+:',
    'eslint.*error', 'warning.*error',
    'FAIL ', 'AssertionError',
    'Exception', 'exception',
    'panic', 'Panic',
    'segfault', 'Segmentation fault',
  ];
  
  // Build a query that matches any error pattern
  const query = errorPatterns.slice(0, 5).join(' OR '); // Use top patterns for FTS
  
  const request = {
    query,
    limit,
    offset,
    project_id: flags.project ? String(flags.project) : undefined,
    session_id: flags.session ? String(flags.session) : undefined,
    event_types: ['tool_result' as EventType], // Errors come from tool outputs
    tool_names: flags.tool ? [String(flags.tool)] : ['Bash', 'bash'], // Usually from Bash
    since,
    until: flags.until ? parseRelativeTime(String(flags.until)) : undefined,
  };
  
  const response = service.search(request);
  
  // Filter results to only those with actual error content
  const errorResults = response.results.filter(r => {
    const text = r.text_redacted?.toLowerCase() || '';
    return (
      text.includes('error') ||
      text.includes('failed') ||
      text.includes('failure') ||
      text.includes('cannot find') ||
      text.includes('is not defined') ||
      text.includes('exception') ||
      /TS\d+:/.test(r.text_redacted || '') ||  // TypeScript errors
      /error\s*\[/.test(text) ||  // Rust/cargo errors
      text.includes('npm err') ||
      text.includes('fail ')
    );
  });
  
  // Build base command for pagination
  const baseArgs = ['recall errors'];
  if (flags.project) baseArgs.push(`--project ${flags.project}`);
  if (flags.session) baseArgs.push(`--session ${flags.session}`);
  if (flags.tool) baseArgs.push(`--tool ${flags.tool}`);
  if (flags.since) baseArgs.push(`--since "${flags.since}"`);
  if (flags.until) baseArgs.push(`--until "${flags.until}"`);
  if (flags.limit) baseArgs.push(`--limit ${flags.limit}`);
  baseArgs.push('--format json');
  const baseCommand = baseArgs.join(' ');
  
  // JSON output
  if (flags.format === 'json') {
    const pagination = buildPagination(offset, limit, errorResults.length, errorResults.length, baseCommand);
    console.log(JSON.stringify({
      results: errorResults,
      pagination,
    }, null, 2));
    return;
  }
  
  // Human readable output
  if (errorResults.length === 0) {
    const timeDesc = since ? `since ${formatDate(since)}` : '(all time)';
    console.log(`No errors found ${timeDesc}.`);
    return;
  }
  
  const timeDesc = since ? `since ${formatDate(since)}` : '(all time)';
  console.log(`Errors (${errorResults.length} found ${timeDesc}):\n`);
  
  for (const result of errorResults) {
    const time = formatTime(result.event_ts);
    const tool = result.tool_name || 'unknown';
    const text = result.text_redacted || '';
    
    // Extract just the error lines (first 10 lines or until we hit something non-error)
    const lines = text.split('\n');
    const errorLines: string[] = [];
    for (const line of lines.slice(0, 20)) {
      if (line.toLowerCase().includes('error') || 
          line.toLowerCase().includes('fail') ||
          line.includes('TS') ||
          line.trim().startsWith('at ') ||  // Stack trace
          errorLines.length > 0 && errorLines.length < 10) {
        errorLines.push(line);
      }
    }
    
    const preview = errorLines.length > 0 
      ? errorLines.slice(0, 5).join('\n  ')
      : lines.slice(0, 3).join('\n  ');
    
    console.log(`${time}  [${tool}]`);
    console.log(`  ${preview}`);
    if (result.session_id) {
      console.log(`  Session: ${result.session_id}`);
    }
    console.log('');
  }
  
  if (errorResults.length >= limit) {
    console.log(`Showing first ${limit}. Use --limit to see more.`);
  }
}

/**
 * Get a slice of content by line numbers
 */
function getLineSlice(content: string, start?: number, end?: number): string {
  const lines = content.split('\n');
  const startIdx = (start ?? 1) - 1;  // Convert to 0-indexed
  const endIdx = end ?? lines.length;
  return lines.slice(startIdx, endIdx).join('\n');
}

function getEventIcon(type: EventType): string {
  switch (type) {
    case 'user_message': return 'user      ';
    case 'assistant_message': return 'assistant ';
    case 'tool_call': return 'tool_call ';
    case 'tool_result': return 'result    ';
    case 'git_commit': return 'commit    ';
    case 'git_branch': return 'branch    ';
    case 'git_merge': return 'merge     ';
    default: return type.padEnd(10);
  }
}

/**
 * Find current session from a unique phrase in user's message
 * Also returns current datetime for grounding
 */
async function cmdSession(service: RecallService, phrase: string | undefined, flags: Record<string, string | boolean>): Promise<void> {
  const result = service.findSession(phrase);
  
  if (flags.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  
  // Human readable
  console.log(`Current time: ${result.local_time}`);
  
  if (!phrase) {
    console.log(`\nUsage: recall session "unique phrase from user message"`);
    return;
  }
  
  if (result.session_id) {
    console.log(`Session: ${result.session_id}`);
    console.log(`Matched: "${result.preview}..."`);
  } else {
    console.log(`No message found matching: "${phrase}"`);
  }
}

async function cmdWatch(service: RecallService, subcommand: string | undefined, flags: Record<string, string | boolean>): Promise<void> {
  // --daemon flag means we're running as background process (check first!)
  if (flags.daemon || process.env.RECALL_DAEMON === '1') {
    writeFileSync(PID_FILE, String(process.pid));
    
    // Uncaught exception handler - log and keep running
    process.on('uncaughtException', (err) => {
      console.error('[WATCHER] Uncaught exception:', err);
      // Don't exit - try to keep running
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      console.error('[WATCHER] Unhandled rejection at:', promise, 'reason:', reason);
      // Don't exit - try to keep running
    });
    
    // Auto-discover and add all sources
    await service.addClaudeCodeSource();
    await service.addOpenCodeSource();
    
    // Start watching
    service.startWatching();
    
    // Handle shutdown
    const cleanup = () => {
      try { unlinkSync(PID_FILE); } catch {}
      service.close();
      process.exit(0);
    };
    
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    
    // chokidar watchers keep the event loop alive - no heartbeat needed
    // The process will stay running as long as watchers are active
    return new Promise(() => {}); // Never resolves
  }
  
  // Handle subcommands: on, off, status (or no subcommand)
  if (subcommand === 'on') {
    startWatcherDaemon();
    return;
  }
  
  if (subcommand === 'off') {
    stopWatcherDaemon();
    return;
  }
  
  // Default: show status
  if (!subcommand || subcommand === 'status') {
    const status = isWatcherRunning();
    if (status.running) {
      console.log(`Watcher: ON (PID ${status.pid})`);
    } else {
      console.log('Watcher: OFF');
    }
    const stats = service.stats();
    console.log(`Events: ${stats.eventCount}`);
    console.log(`Sources: ${stats.sourceCount}`);
    console.log(`\nUsage: recall watch on|off|status`);
    return;
  }
  
  // Unknown subcommand
  console.error(`Unknown watch subcommand: ${subcommand}`);
  console.log('Usage: recall watch on|off|status');
}

async function cmdServe(service: RecallService, flags: Record<string, string | boolean>): Promise<void> {
  // Foreground watching (for debugging)
  console.log('Starting Recall watcher (foreground)...');
  console.log(`  Device: ${service.health().stats.deviceNickname}`);
  
  // Auto-discover and add all sources
  const { claudeSources } = await service.addClaudeCodeSource();
  const { sessionSources } = await service.addOpenCodeSource();
  
  console.log(`  Claude Code: ${claudeSources.length} session(s)`);
  console.log(`  OpenCode: ${sessionSources.length} session(s)`);
  
  // Start watching
  service.startWatching();
  
  const sources = service.listSources();
  const gitSources = sources.filter(s => s.kind === 'git').length;
  console.log(`  Git repos: ${gitSources}`);
  console.log(`  Total sources: ${sources.length}`);
  
  console.log('\nWatching for changes... (Ctrl+C to stop)\n');
  
  // Keep running
  process.on('SIGINT', () => {
    console.log('\nStopping...');
    service.close();
    process.exit(0);
  });
  
  // Print stats periodically
  const startEvents = service.stats().eventCount;
  setInterval(() => {
    const stats = service.stats();
    const newEvents = stats.eventCount - startEvents;
    if (newEvents > 0) {
      console.log(`[${new Date().toLocaleTimeString()}] +${newEvents} events (total: ${stats.eventCount})`);
    }
  }, 10000);
}

// ============================================================================
// Help
// ============================================================================

function printHelp(): void {
  console.log(`
Recall v2 - Universal Memory Layer for AI Agents

USAGE:
  recall <command> [options]

COMMANDS:
  health                       Check Recall status
  
  projects list                List all projects
  projects status              Show last activity for each project (messages, commits, tools)
  
  sources list                 List registered sources
  sources add <type>           Add a source
    Types:
      claude-code              Auto-discover Claude Code session files
      git [--dir <path>]       Add git repo (defaults to current directory)
  sources remove <id> [--purge] Remove a source
  
  ingest                       Ingest from all sources
  
  search <query>               Search events (paginated)
    --type <type>              Filter by event type (user_message, assistant_message, tool_call, tool_result, git_commit)
    --tool <name>              Filter by tool name - supports wildcards (Read, Write, "Parallel*")
    --role <role>              Filter messages by role: user, assistant (no role = all messages)
    --project <id>             Filter by project - accepts ID, display name, or path
    --cwd                      Use current working directory as project filter
    --session <id>             Filter by session - supports wildcards
    --since <time>             Start time (e.g., "2 hours ago")
    --until <time>             End time
    --offset <n>               Pagination offset (default: 0)
    --limit <n>                Max results per page (default: 10)
    --format <fmt>             Output format: table (default), json, jsonl, csv
  
  file <path>                  View file content as seen by agents
    <path>:N                   View from line N (e.g., file.ts:50)
    <path>:N-M                 View lines N to M (e.g., file.ts:50-100)
    --offset <n>               Start at line N (1-based)
    --limit <n>                Number of lines to show
    --at <time>                View file as of a specific time
    --format json              Output as JSON
  
  files                        List files accessed by agents
    --since <time>             Start time
    --until <time>             End time
    --project <id>             Filter by project
    --pattern <glob>           Filter by file pattern (e.g., "*.ts")
    --limit <n>                Max files (default: 50)
    --format json              Output as JSON
  
  diffs                        Show file edits (oldString -> newString)
    --since <time>             Start time (default: 24h)
    --until <time>             End time
    --file <path>              Filter by file path
    --project <id>             Filter by project
    --session <id>             Filter by session
    --limit <n>                Max diffs (default: 20)
    --format json              Output as JSON
  
  reconstruct <path>           Rebuild a file from edit history
    --at <time>                Reconstruct to this point in time (required)
    --output <path>            Save to file instead of stdout
    --session <id>             Filter by session
    --verbose                  Show each edit as it's applied
  
  file-history <path>          Show all versions of a file over time
    --since <time>             Start time
    --until <time>             End time
    --limit <n>                Max versions (default: 20)
    --format json              Output as JSON
  
  history                      Show your requests/messages to agents (paginated)
    --since <time>             Start time (default: 7d)
    --until <time>             End time
    --date <date>              Jump to specific date (e.g., 2026-01-07)
    --all                      Show all time (no time limit)
    --project <id>             Filter by project
    --session <id>             Filter by session
    --offset <n>               Pagination offset (default: 0)
    --limit <n>                Max messages per page (default: 50)
    --full                     Show full message text
    --format <fmt>             Output format: table, json, jsonl
  
  conversation                 Show conversation flow (paginated, scroll through)
    --since <time>             Start time (default: 1d)
    --until <time>             End time  
    --date <date>              Jump to specific date (e.g., 2026-01-07)
    --all                      Show all time (no time limit)
    --project <id>             Filter by project
    --session <id>             Filter by session
    --offset <n>               Start at event N (default: 0)
    --chunk-size <n>           Events per page (default: 20)
    --with-tools               Include tool calls (messages + tools interleaved)
    --tools-only               Show only tool calls
    --full                     Show full text (don't truncate)
    --format json              Compact JSON for agents
  
  timeline                     Show chronological events (paginated)
    --last                     Show minimal summary (last message/commit/tool, which project)
    --last --project <id>      Show last activity for specific project only
    --cwd                      Use current working directory as project filter
    --since <time>             Start time (default: "2h")
                               Formats: ISO date "2026-01-08"
                                        Shorthand "3d", "2w", "6mo"
                                        Human "3 days ago"
                                        Unix timestamp "1704672000"
    --until <time>             End time (default: now)
    --date <date>              Jump to specific date (e.g., 2026-01-07)
    --all                      Show all time (no time limit)
    --type <type>              Filter by event type
    --tool <name>              Filter by tool name - supports wildcards ("Parallel*")
    --role <role>              Filter messages by role: user, assistant
    --project <id>             Filter by project - supports wildcards ("*recall*")
    --session <id>             Filter by session - supports wildcards
    --no-git                   Exclude git events
    --offset <n>               Pagination offset (default: 0)
    --limit <n>                Max events per page (default: 50)
    --format <fmt>             Output format: table (default), json, jsonl, csv
  
  session                      Ground yourself - get current time + find session
    session                      Show current time
    session "phrase"             Find session_id from user's message phrase
    --format json                JSON output for parsing
  
  stats                        Show token usage statistics
    --since <time>             Start time (default: 7d)
    --until <time>             End time
    --project <id>             Filter by project
    --session <id>             Filter by session
    --tier <tier>              Pricing tier: standard (default) | priority
    --by-day                   Group by day (default)
    --by-session               Group by session
    --by-model                 Group by model
    --format json              JSON output
  
  errors                       Show errors (linter, build, test failures)
    --since <time>             Start time (default: 7d)
    --until <time>             End time
    --all                      Show all time (no time limit)
    --project <id>             Filter by project
    --session <id>             Filter by session
    --tool <name>              Filter by tool (default: Bash)
    --limit <n>                Max errors (default: 50)
    --format json              JSON output
  
  around                       Show events around a specific timestamp
    --at <timestamp>           Center timestamp (required)
    --window <minutes>         Minutes before and after (default: 30)
    --project <id>             Filter by project
    --session <id>             Filter by session
    --limit <n>                Max events (default: 50)
    --format json              JSON output
  
  symbols [path]               List or search symbols (functions, classes, etc.)
    symbols                      Show all indexed symbols
    symbols <path>               Show symbols in a file
    symbols <path> --index       Parse & index file from disk
    --search <query>           Search symbols by name (FTS)
    --name <pattern>           Filter by name (wildcards: "get*")
    --kind <type>              Filter by type: function, class, method, interface, type, import
    --language <lang>          Filter by language: typescript, javascript, python
    --exported                 Only exported symbols
    --async                    Only async functions/methods
    --project <id>             Filter by project
    --stats                    Show symbol statistics
    --verbose                  Show signatures and docstrings
    --format json              JSON output
  
  watch                        Manage background watcher daemon
    watch                        Show watcher status
    watch on                     Start background watcher (ingests in real-time)
    watch off                    Stop background watcher
    watch status                 Show watcher status
  
  serve                        Start foreground watcher (for debugging)

TIME FORMATS:
  ISO 8601:        2026-01-08, 2026-01-08T14:30:00
  Shorthand:       3d (3 days), 2w (2 weeks), 6mo (6 months), 1y (1 year)
  Human:           "3 days ago", "2 weeks ago"
  Unix timestamp:  1704672000

EXAMPLES:
  recall sources add claude-code
  recall sources add opencode
  recall sources add cursor
  recall sources add git
  recall sources add git --dir ~/projects/myapp
  recall ingest
  recall search "auth bug"
  recall search "error" --type tool_result --since "3d"
  recall search "error" --tool Bash              # Search only Bash outputs
  recall search "fix" --type git_commit
  recall search "" --role user --limit 20        # Last 20 user messages
  recall search "" --tool "Parallel*"            # Web search tool calls (wildcard)
  recall timeline --role assistant --limit 10    # Last 10 assistant messages
  recall timeline --project "*recall*"           # Events from projects matching "recall"
  recall files --since "1d"                      # List files accessed today
  recall files --pattern "*.ts"                  # List TypeScript files
  recall file /path/to/file.ts                   # View latest content
  recall file /path/to/file.ts:50-100            # View lines 50-100
  recall file /path/to/file.ts --offset 100 --limit 50   # Page through
  recall file /path/to/file.ts --at "2h ago"     # View as of 2 hours ago
  recall diffs --since "1d"                      # Show edits from today
  recall diffs --file /path/to/file.ts           # Edits to specific file
  recall history                                 # Your requests this week
  recall history --since "1d" --full             # Full message text
  recall conversation --since "2h"               # Recent messages (lightweight)
  recall conversation --since "2h" --with-tools  # Messages + tool calls
  recall conversation --since "1d" --offset 20   # Scroll: next 20 events
  recall conversation --session abc --full       # Full session, no truncation
  recall timeline --last                         # Quick summary (minimal tokens)
  recall timeline --since "2026-01-03"
  recall timeline --since "1w"
  recall errors                                  # Errors from today
  recall errors --since "3d"                     # Errors from last 3 days
  recall errors --project myapp --format json    # Project errors as JSON
  recall around --at "2h ago" --window 30        # Events around 2 hours ago
  recall around --at "2026-01-09T17:50:00Z"      # Events around specific time
  recall symbols /path/to/file.ts --index       # Index symbols from a file
  recall symbols /path/to/file.ts               # List symbols in file
  recall symbols --search "handle*"             # Search all symbols
  recall symbols --kind function --exported     # All exported functions
  recall symbols --stats                        # Symbol statistics
  recall serve
`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command, subcommand, flags, positional } = parseArgs(args);
  
  // Help doesn't need service
  if (command === 'help' || flags.help || flags.h) {
    printHelp();
    return;
  }
  
  // Initialize service
  const service = getRecallService();
  
  try {
    switch (command) {
      case 'health':
        await cmdHealth(service);
        break;
        
       case 'sources':
         if (subcommand === 'list' || !subcommand) {
           await cmdSourcesList(service);
         } else if (subcommand === 'add') {
           const type = positional[0];
           if (!type) {
             console.error('Usage: recall sources add <type>');
             console.log('Types: claude-code, git');
             process.exit(1);
           }
           await cmdSourcesAdd(service, type, flags);
         } else if (subcommand === 'remove') {
           const sourceId = positional[0];
           if (!sourceId) {
             console.error('Usage: recall sources remove <source_id>');
             process.exit(1);
           }
           await cmdSourcesRemove(service, sourceId, Boolean(flags.purge));
         } else {
           console.error(`Unknown subcommand: sources ${subcommand}`);
           process.exit(1);
         }
         break;
         
       case 'projects':
         if (subcommand === 'list' || !subcommand) {
           await cmdProjectsList(service, flags);
         } else if (subcommand === 'status') {
           await cmdProjectsStatus(service, flags);
         } else {
           console.error(`Unknown subcommand: projects ${subcommand}`);
           process.exit(1);
         }
         break;
        
      case 'ingest':
        await cmdIngest(service);
        break;
        
      case 'search':
        const query = subcommand;
        if (!query) {
          console.error('Usage: recall search <query>');
          process.exit(1);
        }
        await cmdSearch(service, query, flags);
        break;
        
      case 'topics':
        const topicsQuery = subcommand;
        if (!topicsQuery) {
          console.error('Usage: recall topics <query>');
          process.exit(1);
        }
        await cmdTopics(service, topicsQuery, flags);
        break;
        
      case 'timeline':
        await cmdTimeline(service, flags);
        break;
        
      case 'file':
        const fileArg = subcommand;
        if (!fileArg) {
          console.error('Usage: recall file <path> [--offset N] [--limit N] [--at <time>]');
          process.exit(1);
        }
        await cmdFile(service, fileArg, flags);
        break;
        
      case 'files':
        await cmdFiles(service, flags);
        break;
        
      case 'diffs':
        await cmdDiffs(service, flags);
        break;
        
      case 'reconstruct':
        const reconstructPath = subcommand;
        if (!reconstructPath) {
          console.error('Usage: recall reconstruct <path> --at <time>');
          console.error('Example: recall reconstruct /path/to/file.tsx --at "2026-01-11T01:00:00"');
          process.exit(1);
        }
        await cmdReconstruct(service, reconstructPath, flags);
        break;
        
      case 'history':
        await cmdHistory(service, flags);
        break;
        
      case 'conversation':
        await cmdConversation(service, flags);
        break;
        
      case 'file-history':
        const historyPath = subcommand;
        if (!historyPath) {
          console.error('Usage: recall file-history <path>');
          process.exit(1);
        }
        await cmdFileHistory(service, historyPath, flags);
        break;
        
      case 'session':
        await cmdSession(service, subcommand, flags);
        break;
        
      case 'stats':
        await cmdStats(service, flags);
        break;
        
      case 'errors':
        await cmdErrors(service, flags);
        break;
        
      case 'around':
        await cmdAround(service, flags);
        break;
        
      case 'watch':
        await cmdWatch(service, subcommand, flags);
        break;
        
      case 'serve':
        await cmdServe(service, flags);
        break;
        
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } finally {
    // Don't close for watch/serve commands (they run until stopped)
    if (command !== 'serve' && command !== 'watch') {
      service.close();
    }
  }
}

// Run
main().catch(e => {
  console.error('Error:', e.message || e);
  process.exit(1);
});
