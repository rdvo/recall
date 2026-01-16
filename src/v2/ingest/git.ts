/**
 * Recall v2: Git Ingestion
 * 
 * Ingests git history (commits, branches, merges) from local repositories.
 * Uses git log + diff-tree to capture what actually changed.
 */

import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { Event, GitCommitMeta, GitBranchMeta, Cursor } from '../types.js';
import { findGitRoot, getGitRemote } from '../identity.js';

// ============================================================================
// Git Operations
// ============================================================================

/**
 * Check if a directory is a git repository
 */
export function isGitRepo(dir: string): boolean {
  const gitRoot = findGitRoot(dir);
  return gitRoot !== undefined;
}

/**
 * Get commits since a timestamp
 */
export function getCommitsSince(gitRoot: string, since?: string): GitCommit[] {
  try {
    // Format: %H|%h|%s|%an|%ae|%aI|%P
    // %H = full hash, %h = short hash, %s = subject, %an = author name, %ae = author email
    // %aI = author date ISO, %P = parent hashes
    const sinceArg = since ? `--since="${since}"` : '--all';
    
    // Get current user's git author to filter only their commits
    let authorFilter = '';
    try {
      const userName = execSync('git config user.name', { cwd: gitRoot, encoding: 'utf-8' }).trim();
      if (userName) {
        authorFilter = `--author="${userName}"`;
      }
    } catch {}
    
    const cmd = `git log ${sinceArg} ${authorFilter} --format="%H|%h|%s|%an|%ae|%aI|%P" --numstat`;
    
    const output = execSync(cmd, {
      cwd: gitRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    
    if (!output) return [];
    
    return parseGitLog(output, gitRoot);
  } catch (e) {
    console.warn(`Failed to get git commits: ${e}`);
    return [];
  }
}

interface GitCommit {
  sha: string;
  short_sha: string;
  message: string;
  author_name: string;
  author_email: string;
  commit_ts: string;
  parent_hashes: string[];
  files: Array<{
    path: string;
    status: 'A' | 'M' | 'D' | 'R';
    insertions: number;
    deletions: number;
  }>;
  branch?: string;
  tags?: string[];
}

/**
 * Parse git log output with --numstat
 */
function parseGitLog(output: string, gitRoot: string): GitCommit[] {
  const commits: GitCommit[] = [];
  const lines = output.split('\n');
  
  let currentCommit: Partial<GitCommit> | null = null;
  
  for (const line of lines) {
    if (!line.trim()) {
      // Empty line - might be separator between commit header and numstat
      // Don't finalize commit yet, keep parsing
      continue;
    }
    
    // Check if this is a commit header line
    if (line.includes('|') && !line.match(/^\d+\s+\d+\s+/)) {
      // Save previous commit
      if (currentCommit && currentCommit.sha) {
        commits.push(currentCommit as GitCommit);
      }
      
      // Parse new commit header
      const parts = line.split('|');
      if (parts.length >= 6) {
        const parents = parts[6] ? parts[6].trim().split(' ') : [];
        
        currentCommit = {
          sha: parts[0],
          short_sha: parts[1],
          message: parts[2],
          author_name: parts[3],
          author_email: parts[4],
          commit_ts: parts[5],
          parent_hashes: parents,
          files: [],
        };
        
        // Try to get branch for this commit
        try {
          const branch = execSync(`git branch --contains ${parts[0]} --format='%(refname:short)' | head -1`, {
            cwd: gitRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          if (branch) currentCommit.branch = branch;
        } catch {}
      }
    } else if (currentCommit && line.match(/^\d+\s+\d+\s+/)) {
      // This is a numstat line: insertions deletions filename
      const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
      if (match) {
        const insertions = match[1] === '-' ? 0 : parseInt(match[1], 10);
        const deletions = match[2] === '-' ? 0 : parseInt(match[2], 10);
        const path = match[3];
        
        // Determine status (A=added, M=modified, D=deleted)
        let status: 'A' | 'M' | 'D' | 'R' = 'M';
        if (insertions > 0 && deletions === 0) status = 'A';
        else if (insertions === 0 && deletions > 0) status = 'D';
        
        currentCommit.files = currentCommit.files || [];
        currentCommit.files.push({
          path,
          status,
          insertions,
          deletions,
        });
      }
    }
  }
  
  // Don't forget the last commit
  if (currentCommit && currentCommit.sha) {
    commits.push(currentCommit as GitCommit);
  }
  
  return commits;
}

/**
 * Get current branch name
 */
export function getCurrentBranch(gitRoot: string): string | undefined {
  try {
    const branch = execSync('git branch --show-current', {
      cwd: gitRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect branch switches by reading .git/logs/HEAD
 */
export function getBranchSwitchesSince(gitRoot: string, since?: string): Array<{ from: string; to: string; ts: string; from_sha: string; to_sha: string }> {
  const headLogPath = join(gitRoot, '.git', 'logs', 'HEAD');
  
  if (!existsSync(headLogPath)) return [];
  
  try {
    const content = readFileSync(headLogPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const switches: Array<{ from: string; to: string; ts: string; from_sha: string; to_sha: string }> = [];
    
    const sinceTs = since ? new Date(since).getTime() / 1000 : 0;
    
    for (const line of lines) {
      // Format: old_sha new_sha Name <email> timestamp tz\tcheckout: moving from branch1 to branch2
      const match = line.match(/^([a-f0-9]+) ([a-f0-9]+) .+ (\d+) [+-]\d+\tcheckout: moving from (.+) to (.+)$/);
      
      if (match) {
        const timestamp = parseInt(match[3], 10);
        
        if (timestamp >= sinceTs) {
          switches.push({
            from_sha: match[1],
            to_sha: match[2],
            from: match[4],
            to: match[5],
            ts: new Date(timestamp * 1000).toISOString(),
          });
        }
      }
    }
    
    return switches;
  } catch (e) {
    console.warn(`Failed to read HEAD log: ${e}`);
    return [];
  }
}

// ============================================================================
// Event Normalization
// ============================================================================

interface NormalizationContext {
  sourceId: string;
  deviceId: string;
  projectId: string;
  sourceKind: 'git';
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
 * Normalize a git commit to an Event
 */
export function normalizeGitCommit(
  commit: GitCommit,
  sourceSeq: number,
  ctx: NormalizationContext
): Event {
  const totalInsertions = commit.files.reduce((sum, f) => sum + f.insertions, 0);
  const totalDeletions = commit.files.reduce((sum, f) => sum + f.deletions, 0);
  
  // Build searchable text
  const fileSummary = commit.files
    .map(f => `${f.path} (+${f.insertions} -${f.deletions})`)
    .join(', ');
  
  const text = `git commit ${commit.short_sha}: "${commit.message}"\nFiles: ${fileSummary}${commit.branch ? `\nBranch: ${commit.branch}` : ''}`;
  
  // Build metadata
  const meta: GitCommitMeta = {
    sha: commit.sha,
    short_sha: commit.short_sha,
    message: commit.message,
    author_name: commit.author_name,
    author_email: commit.author_email,
    commit_ts: commit.commit_ts,
    files_changed: commit.files.length,
    insertions: totalInsertions,
    deletions: totalDeletions,
    files: commit.files,
    branch: commit.branch,
    tags: commit.tags,
  };
  
  const filePaths = commit.files.map(f => f.path);
  
  return {
    event_id: generateEventId(ctx.sourceId, sourceSeq, commit.sha),
    source_id: ctx.sourceId,
    source_seq: sourceSeq,
    device_id: ctx.deviceId,
    project_id: ctx.projectId,
    event_ts: commit.commit_ts,
    ingest_ts: new Date().toISOString(),
    source_kind: ctx.sourceKind,
    event_type: 'git_commit',
    text_redacted: text,
    file_paths: filePaths.length > 0 ? filePaths : undefined,
    meta_json: JSON.stringify(meta),
  };
}

/**
 * Normalize a branch switch to an Event
 */
export function normalizeGitBranchSwitch(
  sw: { from: string; to: string; ts: string; from_sha: string; to_sha: string },
  sourceSeq: number,
  ctx: NormalizationContext
): Event {
  const text = `git checkout: ${sw.from} → ${sw.to}`;
  
  const meta: GitBranchMeta = {
    from_branch: sw.from,
    to_branch: sw.to,
    from_sha: sw.from_sha,
    to_sha: sw.to_sha,
  };
  
  return {
    event_id: generateEventId(ctx.sourceId, sourceSeq, `${sw.from}:${sw.to}:${sw.ts}`),
    source_id: ctx.sourceId,
    source_seq: sourceSeq,
    device_id: ctx.deviceId,
    project_id: ctx.projectId,
    event_ts: sw.ts,
    ingest_ts: new Date().toISOString(),
    source_kind: ctx.sourceKind,
    event_type: 'git_branch',
    text_redacted: text,
    meta_json: JSON.stringify(meta),
  };
}

// ============================================================================
// Ingestion Orchestrator
// ============================================================================

export interface GitIngestResult {
  sourceId: string;
  gitRoot: string;
  commitsProcessed: number;
  branchSwitchesProcessed: number;
  eventsCreated: number;
  errors: string[];
}

/**
 * Ingest new git events from a repository
 */
export function ingestGitRepo(
  gitRoot: string,
  cursor: Cursor | undefined,
  ctx: Omit<NormalizationContext, 'sourceKind'>
): { events: Event[]; newCursor: Cursor; result: GitIngestResult } {
  const result: GitIngestResult = {
    sourceId: ctx.sourceId,
    gitRoot,
    commitsProcessed: 0,
    branchSwitchesProcessed: 0,
    eventsCreated: 0,
    errors: [],
  };
  
  const fullCtx: NormalizationContext = {
    ...ctx,
    sourceKind: 'git',
  };
  
  // Determine since time
  let since: string | undefined;
  if (cursor?.updated_at) {
    since = cursor.updated_at;
  } else {
    // First run - get last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    since = thirtyDaysAgo.toISOString();
  }
  
  // Get starting sequence number
  let sourceSeq = cursor?.last_rowid ?? 0;
  
  const events: Event[] = [];
  
  // Get commits
  try {
    const commits = getCommitsSince(gitRoot, since);
    result.commitsProcessed = commits.length;
    
    for (const commit of commits) {
      const event = normalizeGitCommit(commit, sourceSeq, fullCtx);
      events.push(event);
      sourceSeq++;
    }
  } catch (e) {
    result.errors.push(`Failed to get commits: ${e}`);
  }
  
  // Get branch switches
  try {
    const switches = getBranchSwitchesSince(gitRoot, since);
    result.branchSwitchesProcessed = switches.length;
    
    for (const sw of switches) {
      const event = normalizeGitBranchSwitch(sw, sourceSeq, fullCtx);
      events.push(event);
      sourceSeq++;
    }
  } catch (e) {
    result.errors.push(`Failed to get branch switches: ${e}`);
  }
  
  result.eventsCreated = events.length;
  
  // Create new cursor
  const newCursor: Cursor = {
    source_id: ctx.sourceId,
    last_rowid: sourceSeq,
    updated_at: new Date().toISOString(),
  };
  
  return { events, newCursor, result };
}
