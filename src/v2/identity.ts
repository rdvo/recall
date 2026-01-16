/**
 * Recall v2: Device Identity and Project Detection
 */

import { createHash, randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir, hostname } from 'os';
import { join, dirname } from 'path';

// ============================================================================
// Device Identity
// ============================================================================

const CONFIG_DIR = join(homedir(), '.config', 'recall');
const DEVICE_FILE = join(CONFIG_DIR, 'device.json');

interface DeviceConfig {
  device_id: string;
  nickname: string;
  created_at: string;
}

/**
 * Get or create a stable device identity
 */
export function getDeviceIdentity(): DeviceConfig {
  // Try to load existing identity
  if (existsSync(DEVICE_FILE)) {
    try {
      const data = JSON.parse(readFileSync(DEVICE_FILE, 'utf-8'));
      if (data.device_id && data.nickname) {
        return data;
      }
    } catch {
      // Fall through to create new identity
    }
  }

  // Create new identity
  const identity: DeviceConfig = {
    device_id: randomUUID(),
    nickname: getDefaultNickname(),
    created_at: new Date().toISOString(),
  };

  // Save it
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(DEVICE_FILE, JSON.stringify(identity, null, 2));

  return identity;
}

/**
 * Generate a default nickname for this device
 */
function getDefaultNickname(): string {
  const host = hostname();
  
  // Try to get a more descriptive name on macOS
  try {
    const computerName = execSync('scutil --get ComputerName 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (computerName) return computerName;
  } catch {}

  return host || 'Unknown Device';
}

// ============================================================================
// Project Detection
// ============================================================================

interface ProjectInfo {
  project_id: string;
  display_name: string;
  git_remote?: string;
  root_path: string;
}

/**
 * Detect project info from a directory path
 * Uses git remote + root path to create stable project ID
 */
export function detectProject(dir: string): ProjectInfo {
  const gitRoot = findGitRoot(dir);
  
  if (gitRoot) {
    const gitRemote = getGitRemote(gitRoot);
    const displayName = extractDisplayName(gitRemote, gitRoot);
    const projectId = createProjectId(gitRemote, gitRoot);
    
    return {
      project_id: projectId,
      display_name: displayName,
      git_remote: gitRemote,
      root_path: gitRoot,
    };
  }

  // Non-git project: use directory path
  return {
    project_id: createProjectId(undefined, dir),
    display_name: dirname(dir).split('/').pop() || dir,
    root_path: dir,
  };
}

/**
 * Find the git root directory from a path
 */
export function findGitRoot(dir: string): string | undefined {
  try {
    const result = execSync('git rev-parse --show-toplevel', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return result || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get the primary git remote URL
 */
export function getGitRemote(gitRoot: string): string | undefined {
  try {
    // Try origin first
    const origin = execSync('git remote get-url origin 2>/dev/null', {
      cwd: gitRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (origin) return normalizeGitUrl(origin);
  } catch {}

  try {
    // Fall back to first remote
    const remotes = execSync('git remote', {
      cwd: gitRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n');
    
    if (remotes.length > 0 && remotes[0]) {
      const url = execSync(`git remote get-url ${remotes[0]}`, {
        cwd: gitRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return normalizeGitUrl(url);
    }
  } catch {}

  return undefined;
}

/**
 * Normalize git URL to a canonical form
 * git@github.com:user/repo.git -> github.com/user/repo
 * https://github.com/user/repo.git -> github.com/user/repo
 */
function normalizeGitUrl(url: string): string {
  // SSH format: git@github.com:user/repo.git
  const sshMatch = url.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  // HTTPS format: https://github.com/user/repo.git
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/(.+?)(\.git)?$/);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  return url;
}

/**
 * Extract a display name from git remote or path
 */
function extractDisplayName(gitRemote: string | undefined, rootPath: string): string {
  if (gitRemote) {
    // Extract repo name from remote
    const parts = gitRemote.split('/');
    return parts[parts.length - 1] || parts[parts.length - 2] || gitRemote;
  }

  // Use directory name
  return rootPath.split('/').pop() || rootPath;
}

/**
 * Create a stable project ID from remote + path
 */
function createProjectId(gitRemote: string | undefined, rootPath: string): string {
  // If we have a git remote, use it as primary identifier (device-independent)
  // Otherwise fall back to path (device-dependent)
  const identifier = gitRemote || rootPath;
  
  // Create a short hash
  const hash = createHash('sha256').update(identifier).digest('hex').slice(0, 16);
  
  // Create human-readable prefix
  const prefix = extractDisplayName(gitRemote, rootPath)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 20);
  
  return `${prefix}-${hash}`;
}

// ============================================================================
// Session Detection (Claude Code specific)
// ============================================================================

/**
 * Extract session ID from Claude Code JSONL path
 * Path format: ~/.claude/projects/<project-hash>/<session-id>.jsonl
 */
export function extractClaudeSessionId(jsonlPath: string): string | undefined {
  const match = jsonlPath.match(/([a-f0-9-]+)\.jsonl$/i);
  return match ? match[1] : undefined;
}

/**
 * Extract project hash from Claude Code path
 */
export function extractClaudeProjectHash(jsonlPath: string): string | undefined {
  const match = jsonlPath.match(/projects\/([^/]+)\//);
  return match ? match[1] : undefined;
}
