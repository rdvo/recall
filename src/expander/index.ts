import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { LLMProvider } from '../llm/providers.js';
import type { SearchPlan, ExpansionMetadata } from '../types.js';
import { EXPAND_PROMPT, PLAN_PROMPT, SYSTEM } from './prompts.js';

// Zod schema for search plan structured output (converted to JSON schema for Cerebras)
const SearchPlanSchema = z.object({
  actions: z.array(z.object({
    type: z.enum(['fts', 'regex_like']),
    query: z.string().optional(),
    pattern: z.string().optional(),
    weight: z.number().min(0).max(2).optional()
  })),
  keywords: z.array(z.string()),
  paraphrases: z.array(z.string()).optional(),
  technical: z.array(z.string()).optional(),
  concepts: z.array(z.string()).optional(),
  explain: z.string().optional()
});

const searchPlanSchema = zodToJsonSchema(SearchPlanSchema, 'SearchPlan');

// Simple schema for structured output (legacy)
const searchTermsSchema = {
  type: "object",
  properties: {
    terms: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["terms"],
  additionalProperties: false
};

export class Expander {
  private llm: LLMProvider;
  private useStructured: boolean;

  constructor(llm: LLMProvider, useStructured: boolean = false) {
    this.llm = llm;
    this.useStructured = useStructured;
  }

  /**
   * Generate a search plan with multiple parallel search actions
   */
  async plan(query: string): Promise<{ plan: SearchPlan; metadata: ExpansionMetadata }> {
    const prompt = PLAN_PROMPT(query);
    let result: SearchPlan;
    
    if (this.useStructured && 'completeStructured' in this.llm) {
      try {
        result = await this.llm.completeStructured<SearchPlan>(
          prompt,
          searchPlanSchema,
          SYSTEM
        );
      } catch (error) {
        // Fallback to non-structured if structured fails (e.g., truncated response)
        console.warn('Structured plan failed, falling back to text completion');
        const text = await this.llm.complete(prompt, SYSTEM);
        result = this.extractJSON<SearchPlan>(text);
      }
    } else {
      const text = await this.llm.complete(prompt, SYSTEM);
      result = this.extractJSON<SearchPlan>(text);
    }
    
    const parsed = SearchPlanSchema.safeParse(result);
    if (!parsed.success) {
      // Create a minimal fallback plan with the original query
      console.warn('Invalid search plan from LLM, using fallback');
      result = {
        actions: [
          { type: 'fts', query: query, weight: 1.0 },
          { type: 'fts', query: `"${query}"`, weight: 1.2 }
        ],
        keywords: query.split(/\s+/).filter(w => w.length > 2),
        paraphrases: [],
        technical: [],
        concepts: []
      };
    } else {
      result = parsed.data as SearchPlan;
    }

    const normalized = this.normalizePlan(result);
    
    // Log the generated plan
    this.logPlan(query, normalized.plan, normalized.metadata);
    
    return normalized;
  }

  /**
   * Log the generated search plan to a file
   */
  private logPlan(query: string, plan: SearchPlan, metadata: ExpansionMetadata): void {
    try {
      const logDir = process.env.LOG_DIR || './logs';
      const cwd = process.cwd();
      
      // Ensure log directory exists
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
      
      const logFile = join(logDir, 'llm-queries.log');
      const timestamp = new Date().toISOString();
      
      const logEntry = {
        timestamp,
        query,
        plan: {
          actions: plan.actions.map(a => ({
            type: a.type,
            query: a.type === 'fts' ? a.query : undefined,
            pattern: a.type === 'regex_like' ? a.pattern : undefined,
            weight: a.weight
          })),
          concepts: plan.concepts || []
        },
        expansion: {
          keywords: metadata.keywords,
          paraphrases: metadata.paraphrases,
          technical: metadata.technical,
          concepts: metadata.concepts,
          actionsCount: metadata.actionsCount
        }
      };
      
      const logLine = JSON.stringify(logEntry) + '\n';
      appendFileSync(logFile, logLine, 'utf8');
    } catch (error) {
      // Silently fail if logging doesn't work
      console.warn('Failed to log query plan:', error);
    }
  }

  /**
   * Simple: Turn user query into search terms (legacy method)
   */
  async expand(query: string): Promise<string[]> {
    if (this.useStructured && 'completeStructured' in this.llm) {
      const result = await this.llm.completeStructured<{ terms: string[] }>(
        EXPAND_PROMPT(query),
        searchTermsSchema,
        SYSTEM
      );
      return result.terms;
    } else {
      const text = await this.llm.complete(EXPAND_PROMPT(query), SYSTEM);
      const parsed = this.extractJSON<any>(text);
      return Array.isArray(parsed) ? parsed : parsed.terms || [];
    }
  }

  /**
   * Extract JSON from potentially fenced or noisy text
   */
  private extractJSON<T>(text: string): T {
    // Try to find JSON in markdown code fences
    const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]) as T;
      } catch {
        // Fall through to other methods
      }
    }

    // Try to find JSON object/array directly
    const directMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (directMatch) {
      try {
        return JSON.parse(directMatch[1]) as T;
      } catch {
        // Fall through
      }
    }

    // Last resort: try parsing the whole text
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Failed to extract JSON from LLM response: ${text.slice(0, 200)}`);
    }
  }

  /**
   * Normalize plan to ensure required fields and defaults
   */
  private normalizePlan(plan: Partial<SearchPlan>): { plan: SearchPlan; metadata: ExpansionMetadata } {
    const normalized: SearchPlan = {
      actions: plan.actions || [],
      keywords: plan.keywords || [],
      paraphrases: plan.paraphrases || [],
      technical: plan.technical || [],
      concepts: plan.concepts || [],
      explain: plan.explain
    };

    // Ensure actions have weights
    normalized.actions = normalized.actions.map(action => ({
      ...action,
      weight: action.weight ?? 1.0
    }));

    // Validate actions
    normalized.actions = normalized.actions.filter(action => {
      if (action.type === 'fts') {
        return 'query' in action && typeof action.query === 'string' && action.query.length > 0;
      } else if (action.type === 'regex_like') {
        return 'pattern' in action && typeof action.pattern === 'string' && action.pattern.length > 0;
      }
      return false;
    });

    const metadata: ExpansionMetadata = {
      keywords: normalized.keywords,
      paraphrases: normalized.paraphrases || [],
      technical: normalized.technical || [],
      concepts: normalized.concepts || [],
      actionsCount: normalized.actions.length
    };

    return { plan: normalized, metadata };
  }
}
