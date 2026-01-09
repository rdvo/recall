// Query planner prompt - generate multiple search actions (FTS + regex-like)
const SYSTEM = `You are a semantic search query planner. Understand the MEANING and INTENT behind queries.
Generate MANY parallel search strategies that capture semantic relationships AND concrete evidence (values, paths, ids).

CRITICAL: When queries ask about relationships, attributes, or properties (e.g., "X's last name", "who is Y", "what is Z"),
you MUST generate queries that:
1. Extract the subject entity and related entities
2. Include queries that combine the subject with potential answer values
3. Generate queries using synonyms and related terms for the attribute being asked about
4. Look for answer patterns in context (e.g., "X and Y", "X married Y", "X's surname is Y")

Return a JSON object with search actions and expansion metadata.`;

export const PLAN_PROMPT = (query: string) => `User query: "${query}"

Analyze the SEMANTIC MEANING and INTENT of this query. Generate a comprehensive search plan:

1. FTS Actions (8-12 queries - MORE IS BETTER for robustness):
   CRITICAL: FTS5 syntax - spaces = AND, OR = OR, * = wildcard. NO "AND" keyword!
   ALWAYS use * wildcards for multi-word phrases!
   
   Generate DIVERSE queries covering:
   a) Exact/literal matches: "exact phrase*" from the query
   a2) Strict phrase: one or two queries with the query (or key entities) in quotes, e.g., "doctor tj eckleburg"
   b) Semantic synonyms: related terms that mean the same thing
   c) Technical variations: domain-specific terminology
   d) Concrete value patterns (generic): URLs, paths, ids, tokens, code/config lines
      - URLs/paths: "http*", "https*", "/api/*", "/v2/*", "/auth/*", "/login*"
      - Emails/hosts: "*@*", "*.com", "domain*"
      - IDs/tokens: "token*", "id*", "key*", "secret*", "config*", "endpoint*"
   e) Question variations: if asking "where is X", also search "X is located" "X endpoint" "X URL"
   f) Broader context: related concepts that might contain the answer
   g) RELATIONSHIP QUERIES (CRITICAL for semantic understanding - GENERATE MANY QUERIES):
      - If query asks about attributes/relationships (e.g., "X's last name", "X's email", "X's address"):
        * Extract the subject entity (e.g., "Daisy" from "Daisy's last name")
        * Generate MANY queries (8-12) that include the subject + potential answer patterns:
          * "[Subject] [Attribute]" (e.g., "Daisy Buchanan", "Daisy surname", "Daisy family name")
          * "[Subject] [Related Entity]" (e.g., if asking about spouse's name, include "Tom Daisy", "Daisy Tom")
          * "[Attribute] [Subject]" (e.g., "Buchanan Daisy", "surname Daisy")
          * "[Subject] [Common Values]" (e.g., "Daisy Buchanan", "Daisy Tom", "Daisy Wilson")
          * "[Related Entity] [Subject]" (e.g., "Tom Daisy", "Buchanan Daisy", "Tom Buchanan Daisy")
          * "[Subject] [Related Entity]" (e.g., "Daisy Tom", "Daisy Buchanan", "Daisy Tom Buchanan")
          * Simple entity pairs: "[Subject] [Related Entity]" OR "[Related Entity] [Subject]" (e.g., "Daisy Tom" OR "Tom Daisy")
          * With relationship words: "[Related Entity] and [Subject]" (e.g., "Tom Buchanan and Daisy", "Tom and Daisy")
          * Full name patterns: "[Full Name] [Subject]" (e.g., "Tom Buchanan Daisy", "Buchanan Daisy")
          * Context patterns: "[Subject] [Related Entity] [Context]" (e.g., "Daisy Tom Buchanan", "Daisy wife Tom", "Daisy married Tom")
        * Include synonyms for the attribute being asked about:
          * "last name" → "surname", "family name", "lastname", "Buchanan", "Tom Buchanan", "Mr. Buchanan"
          * "email" → "email address", "@", "contact"
          * "address" → "location", "residence", "lives at"
        * Generate queries that look for the answer in context:
          * "[Related Entity] and [Subject]" (e.g., "Tom Buchanan and Daisy", "Tom and Daisy")
          * "[Related Entity] [Subject] [Relationship]" (e.g., "Tom Buchanan Daisy", "Daisy married Tom")
          * "[Subject] [Related Entity] [Context]" (e.g., "Daisy Tom Buchanan", "Daisy wife Tom")
          * "[Full Name] [Subject]" (e.g., "Tom Buchanan Daisy", "Buchanan Daisy")
        * For "last name" queries specifically, also generate:
          * "[Subject] [Common Surname Patterns]" (e.g., if subject is "Daisy", try "Daisy Buchanan", "Daisy Wilson", etc.)
          * "[Subject] [Husband/Wife Name]" (e.g., "Tom Buchanan" if asking about Daisy's last name)
          * "[Husband/Wife Full Name] [Subject]" (e.g., "Tom Buchanan Daisy")
          * "[Subject] [Husband/Wife First Name] [Husband/Wife Last Name]" (e.g., "Daisy Tom Buchanan")
      - If query asks "what is X" or "who is X", generate queries for:
        * "X is" OR "X was" OR "X's" OR "X name" OR "X called"
        * Related entities that might mention X (e.g., if asking about "Daisy", include "Tom", "Gatsby", "Nick")
        * "[Related Entity] AND X" to find contexts where both appear together

   IMPORTANT: Include at least 2-3 queries that look for CONCRETE VALUES (URLs/paths/ids/tokens)
   to distinguish real answers from generic discussion.

2. Regex-like Actions (2-4 patterns - generic, not domain-specific):
   - "http%" or "https%"
   - "%/%/%" (paths)
   - "%@%" (emails/hosts)
   - "%token%" "%id%" "%key%" "%secret%" "%password%" "%config%" "%endpoint%" "%url%" "%path%"

3. Expansion metadata:
   - keywords: 10-15 terms (include generic concrete markers like "http", "endpoint", "@", "token", "id")
     * For relationship queries, include: subject entity, potential answer values, attribute synonyms
     * Example: For "Daisy's last name" → ["Daisy", "Buchanan", "Tom", "surname", "family name", "lastname", "Tom Buchanan", "Daisy Buchanan"]
   - paraphrases: 3-5 alternative phrasings
     * Include relationship-aware rephrasings (e.g., "Daisy's last name" → "Daisy surname", "Buchanan Daisy", "Tom Buchanan and Daisy")
   - technical: 3-5 technical terms
   - concepts: 2-3 high-level concepts
     * For relationship queries, include concepts like "family relationships", "personal attributes", "entity properties"

KEY INSIGHT: Documents with ACTUAL VALUES (URLs, paths, ids, tokens, config lines) are more likely to be the answer
than documents that just DISCUSS those topics. Generate queries that find concrete evidence.

Return JSON:
{
  "actions": [
    {"type": "fts", "query": "exact phrase* OR synonyms*", "weight": 1.0},
    {"type": "fts", "query": "http* OR https* OR endpoint* OR url*", "weight": 1.1},
    {"type": "fts", "query": "token* OR id* OR secret* OR key*", "weight": 1.0},
    {"type": "regex_like", "pattern": "http%", "weight": 1.1},
    {"type": "regex_like", "pattern": "%/%/%", "weight": 1.0},
    {"type": "regex_like", "pattern": "%@%", "weight": 0.9}
  ],
  "keywords": ["term1", "term2", ...],
  "paraphrases": ["paraphrase 1", ...],
  "technical": ["tech term", ...],
  "concepts": ["concept1", ...]
}`; 

// Legacy prompt for backward compatibility
export const EXPAND_PROMPT = (query: string) => `Search query: "${query}"

Generate 5-8 specific search terms. Include:
- Exact words from the query
- 2-3 close synonyms
- 1-2 technical terms

Be SPECIFIC. "password" not "security". "Stripe" not "payment".

JSON array only.`;

export { SYSTEM };
