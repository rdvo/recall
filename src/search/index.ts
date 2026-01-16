import type { DatabaseClient } from '../db/types.js';
import type { Expander } from '../expander/index.js';
import type { Reranker } from './reranker.js';
import type { SearchOptions, SearchResult, SearchAction, ExpansionMetadata } from '../types.js';

// Generic concreteness patterns: prefer docs with actual values over generic discussion
// No domain-specific terms; purely structural signals.
const CONCRETE_PATTERNS: RegExp[] = [
  // URLs and paths
  /https?:\/\/\S+/i,
  /\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/i,
  /[?&][A-Za-z0-9_-]+=\S+/,
  // Emails / hostnames
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  /\b[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  // Key/value or config-like
  /\b[A-Za-z0-9_]+=+[^\s]+/,
  // Long tokens / ids / hex
  /\b[A-Fa-f0-9]{16,}\b/,
  /\b[A-Za-z0-9]{20,}\b/,
  // IP addresses
  /\b\d{1,3}(\.\d{1,3}){3}\b/,
  // Versions / numbers with dots
  /\b\d+\.\d+(\.\d+)?\b/,
  // Braced/JSON-ish snippets
  /\{[^}]{10,}\}/,
  /\[[^\]]{10,}\]/,
  /`[^`]{10,}`/,
];

export interface SimpleSearchResponse {
  results: SearchResult[];
  searchTerms: string[]; // Backward compat
  expansion?: ExpansionMetadata;
  timing: {
    expand: number;
    search: number;
    rerank: number;
    total: number;
  };
}

export class SearchService {
  private db: DatabaseClient;
  private expander: Expander;
  private reranker: Reranker | null;

  constructor(db: DatabaseClient, expander: Expander, reranker?: Reranker) {
    this.db = db;
    this.expander = expander;
    this.reranker = reranker || null;
  }

  private tokenOverlap(query: string, content: string): number {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const qTokens = norm(query).split(/\s+/).filter(t => t.length > 2);
    const cTokens = new Set(norm(content).split(/\s+/).filter(t => t.length > 2));
    if (qTokens.length === 0 || cTokens.size === 0) return 0;
    let hit = 0;
    for (const t of qTokens) {
      if (cTokens.has(t)) hit++;
    }
    return hit / qTokens.length;
  }

  /**
   * Count concreteness markers in content; compute density later
   */
  private countConcrete(content: string): number {
    let count = 0;
    for (const regex of CONCRETE_PATTERNS) {
      if (regex.test(content)) count += 1;
    }
    return count;
  }

  /**
   * Parallel search with query planning:
   * 1. User query → LLM generates search plan (multiple actions)
   * 2. Execute all actions in parallel (FTS + regex-like)
   * 3. Merge and dedupe results by id
   * 4. Optional: LLM reranks merged candidates
   */
  async search(query: string, options: SearchOptions = {}): Promise<SimpleSearchResponse> {
    const startTime = Date.now();
    const limit = options.limit || 20;

    // Step 1: LLM generates search plan
    const expandStart = Date.now();
    const { plan, metadata } = await this.expander.plan(query);
    const expandTime = Date.now() - expandStart;

    // Add a manual strict-phrase FTS action to ensure exact phrase is tried
    const manualActions: SearchAction[] = [];
    const stripped = query.replace(/"/g, '').trim();
    if (stripped.length > 0) {
      manualActions.push({ type: 'fts', query: `"${stripped}"`, weight: 1.2 });
    }


    // Step 2: Execute ALL actions in PARALLEL - maximum speed
    // All database queries (FTS + regex) run simultaneously via Promise.all
    const searchStart = Date.now();
    const baseCandidates = Math.max(limit * 10, 50); // baseline
    const actions = [...plan.actions, ...manualActions];
    const actionResults = await Promise.all(
      actions.map(action => {
        const boostedLimit = action.type === 'regex_like'
          ? Math.max(Math.floor(baseCandidates * 1.5), baseCandidates + 25) // favor high-signal regex
          : Math.max(Math.floor(baseCandidates * 0.6), limit * 5, 30); // fewer broad FTS per action
        return this.executeAction(action, boostedLimit);
      })
    );
    const searchTime = Date.now() - searchStart;

    // Step 3: Apply filters before merging
    const filteredActionResults = this.applyFilters(actionResults, options.filters);

    // Step 4: Merge results by id, combine scores (deterministic)
    let mergedResults = this.mergeResults(query, filteredActionResults, actions);

    // Step 5: Optional reranking (OPT-IN ONLY). Default is deterministic scoring.
    let rerankTime = 0;
    const useRerank = this.reranker !== null && options.rerank !== false;
    if (useRerank) {
      const rerankStart = Date.now();
      mergedResults = await this.reranker!.rerank(query, mergedResults, limit);
      rerankTime = Date.now() - rerankStart;
    }

    mergedResults = mergedResults.slice(0, limit);
    const totalTime = Date.now() - startTime;

    // Backward compat: extract searchTerms from keywords
    const searchTerms = metadata.keywords;

    return {
      results: mergedResults,
      searchTerms,
      expansion: metadata,
      timing: {
        expand: expandTime,
        search: searchTime,
        rerank: rerankTime,
        total: totalTime
      }
    };
  }

  /**
   * Execute a single search action
   */
  private async executeAction(action: SearchAction, limit: number): Promise<SearchResult[]> {
    try {
      if (action.type === 'fts') {
        return await this.db.search(action.query, limit);
      } else if (action.type === 'regex_like') {
        return await this.db.searchWithRegex(action.pattern, limit);
      }
    } catch (error) {
      console.warn(`Search action failed: ${action.type}`, error);
      return [];
    }
    return [];
  }

  /**
   * Filter results per-action by source/tags/time using metadata
   */
  private applyFilters(
    actionResults: SearchResult[][],
    filters?: SearchOptions['filters']
  ): SearchResult[][] {
    if (!filters) return actionResults;
    const { tags, source, since, until } = filters;
    const sinceTs = since ? Date.parse(since) : null;
    const untilTs = until ? Date.parse(until) : null;

    const matchesFilters = (r: SearchResult): boolean => {
      const meta = (r.metadata || {}) as any;
      if (source && meta.source !== source) return false;
      if (tags && tags.length > 0) {
        const docTags: string[] = Array.isArray(meta.tags) ? meta.tags : [];
        const intersects = docTags.some(t => tags.includes(t));
        if (!intersects) return false;
      }
      if (sinceTs) {
        const ct = r.created_at ? Date.parse(r.created_at) : NaN;
        if (!isNaN(ct) && ct < sinceTs) return false;
      }
      if (untilTs) {
        const ct = r.created_at ? Date.parse(r.created_at) : NaN;
        if (!isNaN(ct) && ct > untilTs) return false;
      }
      return true;
    };

    return actionResults.map(results => results.filter(matchesFilters));
  }

  /**
   * Merge results from multiple actions, dedupe by id, combine scores with
   * concreteness density and action-hit boost. Deterministic (no LLM).
   */
  private mergeResults(
    query: string,
    actionResults: SearchResult[][],
    actions: SearchAction[]
  ): SearchResult[] {
    const resultMap = new Map<string, SearchResult & {
      scores: number[];
      weights: number[];
      actionHits: number;
      concreteMarkers: number;
      overlap: number;
    }>();

    for (let i = 0; i < actionResults.length; i++) {
      const results = actionResults[i];
      const action = actions[i];
      let weight = action.weight ?? 1.0;

      // Favor regex (often more precise), slightly downweight broad FTS
      if (action.type === 'regex_like') {
        weight *= 1.2;
      } else {
        weight *= 0.95;
      }

      const maxScore = Math.max(...results.map(r => r.score), 1);
      const normalized = results.map(r => ({
        ...r,
        score: r.score / maxScore,
        weight
      }));

      for (const result of normalized) {
        const concrete = this.countConcrete(result.content);
        const overlap = this.tokenOverlap(query, result.content);
        const existing = resultMap.get(result.id);
        if (existing) {
          existing.scores.push(result.score);
          existing.weights.push(weight);
          existing.actionHits += 1;
          existing.concreteMarkers = Math.max(existing.concreteMarkers, concrete);
          existing.overlap = Math.max(existing.overlap, overlap);
        } else {
          resultMap.set(result.id, {
            ...result,
            scores: [result.score],
            weights: [weight],
            actionHits: 1,
            concreteMarkers: concrete,
            overlap
          });
        }
      }
    }

    const merged: SearchResult[] = Array.from(resultMap.values()).map(item => {
      let combinedScore = 0;
      let totalWeight = 0;
      for (let i = 0; i < item.scores.length; i++) {
        combinedScore += item.scores[i] * item.weights[i];
        totalWeight += item.weights[i];
      }
      const baseScore = totalWeight > 0 ? combinedScore / totalWeight : 0;

      // Concreteness density (markers per ~500 chars)
      const len = Math.max(item.content.length, 1);
      const density = item.concreteMarkers / Math.max(len / 500, 1);
      const concreteBoost = density * 0.2; // modest boost for dense concreteness

      // Small bonus per action hit
      const actionBoost = Math.min(item.actionHits, 6) * 0.01;

      // Overlap with query terms (lexical guardrail)
      const overlapBoost = item.overlap * 1.8;

      // Penalty if zero concrete markers
      const concretePenalty = item.concreteMarkers === 0 ? 0.1 : 0;

      const finalScore = baseScore + concreteBoost + actionBoost + overlapBoost;

      const { scores, weights, actionHits, concreteMarkers, overlap, ...result } = item;
      return {
        ...result,
        score: finalScore - concretePenalty
      };
    });

    merged.sort((a, b) => b.score - a.score);
    return merged;
  }

}
