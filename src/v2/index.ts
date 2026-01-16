/**
 * Recall v2: Universal Memory Layer for AI Agent Harnesses
 * 
 * Main entry point - exports all public APIs
 */

// Types
export * from './types.js';

// Database
export { RecallDB } from './db/client.js';
export { SCHEMA_VERSION, MIGRATIONS } from './db/schema.js';

// Identity
export { 
  getDeviceIdentity, 
  detectProject, 
  findGitRoot, 
  getGitRemote,
  extractClaudeSessionId,
  extractClaudeProjectHash,
} from './identity.js';

// Redaction
export { 
  redactSecrets, 
  redactJsonObject, 
  redactToolArgs,
  testRedaction,
  DEFAULT_REDACTION_PATTERNS,
  type RedactionResult,
} from './redaction.js';

// Ingestion - Claude Code
export {
  discoverClaudeCodeFiles,
  discoverClaudeCodeWorkingDirs,
  extractWorkingDirFromProjectPath,
  ingestClaudeCodeFile,
  readNewLines,
  normalizeClaudeCodeLine,
  isClaudeCodePath,
  type IngestResult,
} from './ingest/claude-code.js';

// Ingestion - Git
export {
  isGitRepo,
  ingestGitRepo,
  getCommitsSince,
  getCurrentBranch,
  getBranchSwitchesSince,
  normalizeGitCommit,
  normalizeGitBranchSwitch,
  type GitIngestResult,
} from './ingest/git.js';

// Service
export { 
  RecallService, 
  getRecallService,
  type RecallConfig,
} from './service.js';
