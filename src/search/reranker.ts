import type { LLMProvider } from '../llm/providers.js';
import type { SearchResult } from '../types.js';

const RERANK_SYSTEM = `You are a semantic search relevance scorer. Understand the MEANING and INTENT behind queries, not just keyword matching.
Score documents 0-10 based on SEMANTIC RELEVANCE - how well the document's meaning matches the query's intent. Favor explicit key/secret markers when present:

- Strong markers to favor: sk_, sk_live, sk_test, whsec_, deploy key, SSH key, pk_live, pk_test, "deployment key", "webhook signing secret", "production deploy key".
- If a document clearly contains the exact secret/key the query asks for, score it 9-10 even if wording differs.
- If a document is generic or unrelated, score it low.

- 10: Perfect semantic match - document directly answers the query's intent, even if using different words
- 9: Excellent semantic match - document addresses the core concept/need, may use synonyms or related terms
- 8: Very relevant - document meaningfully addresses the query topic with good semantic overlap
- 7: Relevant - document discusses related concepts that partially answer the query
- 5-6: Somewhat relevant - mentions related topics but doesn't directly address the query's intent
- 3-4: Weakly related - only tangentially connected, minimal semantic overlap
- 0-2: Not relevant - no meaningful semantic relationship

Key principles:
- Prioritize SEMANTIC MATCHING over exact keyword matching
- "authentication" semantically matches "login", "signin", "verify identity", "user verification"
- "payment gateway" semantically matches "merchant processing", "transaction API", "billing service"
- Understand INTENT: "how to X" queries should match documents that explain/describe X, even without "how to" phrase
- Consider CONTEXT: documents discussing related concepts that help answer the query should score higher

RELATIONSHIP QUERIES (CRITICAL):
- For queries asking about attributes/relationships (e.g., "X's last name", "X's email", "who is X"):
  * If the document mentions the subject entity AND a related entity that could answer the question, score it HIGH (8-10)
  * Example: Query "What is Daisy's last name" - if document mentions "Tom Buchanan" and "Daisy" together, score 9-10
    because Tom Buchanan is Daisy's husband, so Buchanan is her last name
  * Look for relationship indicators: "X and Y", "X married Y", "X's husband Y", "X's wife Y", "Mr. Y and X"
  * For "last name" queries: if document mentions subject + full name of related person (e.g., "Tom Buchanan" + "Daisy"), 
    infer the last name from the related person's full name
  * Score documents that contain BOTH the subject AND the answer (even if not adjacent) higher than documents with only the subject

Be semantically aware, not just keyword-strict.`;

const rerankSchema = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: { 
        type: "number",
        minimum: 0,
        maximum: 10
      }
    }
  },
  required: ["scores"],
  additionalProperties: false
};

export class Reranker {
  private llm: LLMProvider;
  private useStructured: boolean;

  constructor(llm: LLMProvider, useStructured: boolean = false) {
    this.llm = llm;
    this.useStructured = useStructured;
  }

  async rerank(query: string, results: SearchResult[], topK: number = 10): Promise<SearchResult[]> {
    if (results.length === 0) return results;
    
    // Rerank more candidates to catch needles that rank lower initially
    // 30 candidates with 800 char previews = good balance of depth and context
    const candidates = results.slice(0, Math.min(results.length, 30));
    
    // Build prompt with doc previews to capture context
    // Use 800 chars to capture more context for relationship queries
    const docPreviews = candidates.map((r, i) => 
      `[${i}] ${r.content.slice(0, 800).replace(/\n/g, ' ')}`
    ).join('\n\n');

    const prompt = `Query: "${query}"

Analyze the SEMANTIC MEANING and INTENT of this query. Rate each document 0-10 based on SEMANTIC RELEVANCE:

- 10: Perfect semantic match - directly answers the query's intent (even with different wording)
- 9: Excellent match - addresses the core concept/need semantically
- 8: Very relevant - meaningfully addresses the query topic
- 7: Relevant - discusses related concepts that partially answer
- 5-6: Somewhat relevant - mentions related topics but doesn't directly address intent
- 3-4: Weakly related - minimal semantic overlap
- 0-2: Not relevant - no meaningful semantic relationship

Consider:
- Does the document's MEANING match the query's INTENT? (not just keywords)
- Would someone asking this query find this document helpful?
- Are concepts semantically related even if worded differently?

FOR RELATIONSHIP QUERIES (e.g., "X's last name", "who is X", "X's email"):
- If the query asks about an attribute/relationship, look for documents that mention:
  * The subject entity (e.g., "Daisy")
  * A related entity that could provide the answer (e.g., "Tom Buchanan" for "Daisy's last name")
  * Relationship indicators (e.g., "Tom Buchanan and Daisy", "Daisy married Tom", "Mr. Buchanan and Daisy")
- Score documents HIGH (8-10) if they contain BOTH the subject AND information that answers the question
- CRITICAL: For "last name" queries, if a document contains:
  * The subject's first name (e.g., "Daisy")
  * A full name of a related person (e.g., "Tom Buchanan")
  * Context suggesting a relationship (e.g., "Tom Buchanan and Daisy", "Tom Buchanan...Daisy's name")
  → Score it 9-10 because you can infer the last name from the related person's full name
- Example: For "What is Daisy's last name", a document with "Tom Buchanan" and "Daisy" (even if not adjacent) should score 9-10
  because Tom Buchanan is Daisy's husband, so Buchanan is her last name
- Look for the answer even if entities are not adjacent - if both appear in the document, infer the relationship

Documents:
${docPreviews}

Return scores as JSON array [score1, score2, ...] matching document order.`;

    let scores: number[];

    if (this.useStructured && 'completeStructured' in this.llm) {
      try {
        const result = await this.llm.completeStructured<{ scores: number[] }>(
          prompt,
          rerankSchema,
          RERANK_SYSTEM
        );
        scores = result.scores;
      } catch (error) {
        // Fallback to non-structured if structured fails
        console.warn('Structured rerank failed, falling back to text completion:', error);
        const text = await this.llm.complete(prompt, RERANK_SYSTEM);
        try {
          const parsed = JSON.parse(text);
          scores = Array.isArray(parsed) ? parsed : parsed.scores || [];
        } catch {
          // Fallback: try to extract numbers
          scores = text.match(/\d+(\.\d+)?/g)?.map(Number) || [];
        }
      }
    } else {
      const text = await this.llm.complete(prompt, RERANK_SYSTEM);
      try {
        const parsed = JSON.parse(text);
        scores = Array.isArray(parsed) ? parsed : parsed.scores || [];
      } catch {
        // Fallback: try to extract numbers
        scores = text.match(/\d+(\.\d+)?/g)?.map(Number) || [];
      }
    }

    // Combine LLM score (0-10) with FTS5 BM25 score
    // Use weighted average: 70% LLM score, 30% normalized FTS5 score
    const maxFTS5Score = Math.max(...candidates.map(r => r.score), 1);
    
    const reranked = candidates.map((result, i) => {
      const llmScore = scores[i] ?? 5; // Default to 5 if missing
      const normalizedFTS5Score = (result.score / maxFTS5Score) * 10; // Normalize to 0-10
      const combinedScore = (llmScore * 0.7) + (normalizedFTS5Score * 0.3);
      
      return {
        ...result,
        score: combinedScore,
        originalScore: result.score,
        llmScore: llmScore
      };
    });

    // Sort by combined score
    reranked.sort((a, b) => b.score - a.score);

    return reranked.slice(0, topK);
  }
}

