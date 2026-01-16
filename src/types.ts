export interface Document {
  id: string;
  content: string;
  metadata?: Record<string, any>;
  created_at?: string;
}

export interface SearchResult extends Document {
  score: number;
}

export interface SearchOptions {
  limit?: number;
  rerank?: boolean; // Default: true
  filters?: {
    tags?: string[];   // match any
    source?: string;   // exact match
    since?: string;    // ISO timestamp
    until?: string;    // ISO timestamp
  };
}

export interface SearchResponse {
  results: SearchResult[];
  searchTerms: string[]; // What the LLM expanded query into (backward compat)
  expansion?: ExpansionMetadata; // Structured expansion metadata
  timing: {
    expand: number;
    search: number;
    rerank: number;
    total: number;
  };
}

export interface LLMConfig {
  provider: 'openai' | 'groq' | 'ollama' | 'cerebras';
  apiKey?: string;
  model?: string;
  baseURL?: string;
}

export interface IndexRequest {
  id: string;
  content: string;
  metadata?: Record<string, any>;
}

export interface SearchRequest {
  query: string;
  limit?: number;
  rerank?: boolean;
}

// Search Plan DSL - safe query actions the LLM can propose
export type SearchAction = FTSAction | RegexLikeAction;

export interface FTSAction {
  type: 'fts';
  query: string;
  weight?: number; // Optional weight for score combination (default: 1.0)
}

export interface RegexLikeAction {
  type: 'regex_like';
  pattern: string; // Pattern for LIKE-based search (SQLite compatible)
  weight?: number;
}

export interface SearchPlan {
  actions: SearchAction[];
  keywords: string[]; // For display/debugging
  paraphrases?: string[]; // Alternative phrasings
  technical?: string[]; // Technical terms
  concepts?: string[]; // High-level semantic concepts
  explain?: string; // Optional explanation
}

export interface ExpansionMetadata {
  keywords: string[];
  paraphrases: string[];
  technical: string[];
  concepts?: string[]; // Semantic concepts
  actionsCount: number;
}
