#!/usr/bin/env node
import fs from 'fs/promises';
import { dirname, resolve } from 'path';
import readline from 'readline/promises';
import { stdin as input, stdout as output, argv as processArgv } from 'process';
import { startServer } from '../server-main.js';
import { SQLiteClient } from '../db/sqlite-client.js';
import { config } from '../config.js';
import { Expander } from '../expander/index.js';
import { Reranker } from '../search/reranker.js';
import { SearchService } from '../search/index.js';
import { createLLMProvider } from '../llm/providers.js';

type Command =
  | 'serve'
  | 'seed'
  | 'init'
  | 'index'
  | 'search'
  | 'delete'
  | 'wipe'
  | 'stats'
  | 'test'
  | 'test:needle'
  | 'test:heavy'
  | 'test:all'
  | 'logs'
  | 'show-logs'
  | 'help';

type SearchResponse = {
  results?: Array<{
    id: string;
    content: string;
    score: number;
    metadata?: Record<string, unknown>;
  }>;
  expansion?: {
    keywords?: string[];
    paraphrases?: string[];
    technical?: string[];
    concepts?: string[];
  };
  timing?: Record<string, number>;
  error?: string;
};

const args = process.argv.slice(2);
const cmd = (args[0] as Command | undefined) || 'serve';
const baseUrl = config.recallUrl();
const logFile = resolve(process.cwd(), 'logs/llm-queries.log');
const logsDir = dirname(logFile);
const defaultDbPath = config.dbPath();

type ParsedArgs = { _: string[]; [key: string]: string | boolean | string[] | undefined };
type TestMode = 'local' | 'server';

function parseArgs(raw: string[]): ParsedArgs {
  const parsed: ParsedArgs = { _: [] };
  let i = 0;
  while (i < raw.length) {
    const token = raw[i];
    if (token.startsWith('--')) {
      const [key, inlineVal] = token.slice(2).split('=');
      if (inlineVal !== undefined) {
        parsed[key] = inlineVal;
      } else {
        const next = raw[i + 1];
        if (next && !next.startsWith('-')) {
          parsed[key] = next;
          i += 1;
        } else {
          parsed[key] = true;
        }
      }
    } else if (token.startsWith('-')) {
      const key = token.slice(1);
      const next = raw[i + 1];
      if (next && !next.startsWith('-')) {
        parsed[key] = next;
        i += 1;
      } else {
        parsed[key] = true;
      }
    } else {
      parsed._.push(token);
    }
    i += 1;
  }
  return parsed;
}

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function createLocalTestIO(dbPath: string) {
  await ensureDbDir(dbPath);
  const db = new SQLiteClient(dbPath);
  db.initialize();

  const provider = (process.env.LLM_PROVIDER || 'cerebras') as any;
  const llm = createLLMProvider({
    provider,
    apiKey: config.cerebrasApiKey() || process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
  });
  const useStructured = provider === 'cerebras';
  const expander = new Expander(llm, useStructured);
  const reranker = new Reranker(llm, useStructured);
  const searchSvc = new SearchService(db, expander, reranker);

  return {
    async wipeAll() {
      db.deleteAll();
    },
    async indexMany(docs: Array<{ id: string; content: string; metadata?: Record<string, unknown>; created_at?: string }>) {
      db.indexMany(docs);
    },
    async search(query: string, limit = 5): Promise<SearchResponse> {
      const res = await searchSvc.search(query, { limit });
      return { results: res.results, expansion: res.expansion };
    },
    close() {
      db.close();
    },
  };
}

type TestIO = Awaited<ReturnType<typeof createLocalTestIO>> & {
  mode: TestMode;
};

async function createTestIO(useServer: boolean): Promise<TestIO> {
  if (useServer) {
    await ensureServer();
    return {
      mode: 'server',
      async wipeAll() {
        await wipeAll();
      },
      async indexMany(docs) {
        for (const doc of docs) {
          await indexDoc(doc);
        }
      },
      async search(query: string, limit = 5) {
        return search(query, limit);
      },
      close() {},
    };
  }

  const local = await createLocalTestIO(defaultDbPath);
  return { mode: 'local', ...local };
}

function sleep(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function ensureLogsDir() {
  await fs.mkdir(logsDir, { recursive: true });
}

async function fetchJson(path: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const message =
      typeof data === 'string'
        ? data
        : data?.error || data?.message || res.statusText;
    throw new Error(
      `Request to ${path} failed (${res.status}): ${message || 'unknown error'}`
    );
  }

  return data;
}

async function health() {
  return fetchJson('/health');
}

async function waitForHealth(timeoutMs = 15000, intervalMs = 400) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await health();
      return true;
    } catch {
      await sleep(intervalMs);
    }
  }
  return false;
}

async function ensureServer() {
  try {
    await health();
    return;
  } catch (err) {
    throw new Error(
      `Server not reachable at ${baseUrl}. Start it first (e.g., "recall serve" or "npm run dev"). ${(err as Error).message}`
    );
  }
}

async function wipeAll() {
  await fetchJson('/_all', { method: 'DELETE' });
}

function getDbPath(fromArgs?: string | boolean | string[]) {
  if (typeof fromArgs === 'string' && fromArgs.length > 0) return fromArgs;
  return defaultDbPath;
}

async function ensureDbDir(dbPath: string) {
  const dir = dirname(dbPath);
  if (dir && dir !== '.') {
    await fs.mkdir(dir, { recursive: true });
  }
}

async function initCommand(rawArgs: string[]) {
  const flags = parseArgs(rawArgs);
  const dbPath = getDbPath(flags.db || flags.path);
  await ensureDbDir(dbPath);
  const client = new SQLiteClient(dbPath);
  client.close();
  console.log(`Initialized store at ${dbPath}`);
}

async function indexCommand(rawArgs: string[]) {
  const flags = parseArgs(rawArgs);
  const dbPath = getDbPath(flags.db || flags.path);
  await ensureDbDir(dbPath);
  const client = new SQLiteClient(dbPath);

  try {
    const id = typeof flags.id === 'string' ? flags.id : undefined;
    const contentFlag = typeof flags.content === 'string' ? flags.content : undefined;
    const filePath = typeof flags.file === 'string' ? flags.file : undefined;
    const metadataRaw = typeof flags.metadata === 'string' ? flags.metadata : undefined;

    let metadata: Record<string, unknown> | undefined;
    if (metadataRaw) {
      try {
        metadata = JSON.parse(metadataRaw);
      } catch (err) {
        throw new Error(`Invalid metadata JSON: ${(err as Error).message}`);
      }
    }

    let bodyText: string | null = null;
    if (filePath) {
      bodyText = await fs.readFile(filePath, 'utf8');
    } else if (contentFlag) {
      bodyText = contentFlag;
    } else {
      bodyText = await readStdin();
    }

    if (bodyText === null) {
      throw new Error('No content provided. Use --content, --file, or pipe JSON to stdin.');
    }

    // Try to parse JSON for batch input if no explicit id
    if (!id) {
      try {
        const parsed = JSON.parse(bodyText);
        if (Array.isArray(parsed)) {
          const docs = parsed.map((doc) => {
            if (!doc.id || !doc.content) {
              throw new Error('Each document must have id and content');
            }
            return {
              id: String(doc.id),
              content: String(doc.content),
              metadata: doc.metadata,
              created_at: doc.created_at,
            };
          });
          client.indexMany(docs);
          console.log(`Indexed ${docs.length} documents into ${dbPath}`);
          return;
        }
      } catch {
        // fall through to single doc path
      }
    }

    if (!id) {
      throw new Error('Missing --id for single document index (or supply batch JSON array via stdin/file).');
    }

    client.index({
      id,
      content: bodyText,
      metadata,
    });
    console.log(`Indexed document ${id} into ${dbPath}`);
  } finally {
    client.close();
  }
}

async function searchCommand(rawArgs: string[]) {
  const flags = parseArgs(rawArgs);
  const dbPath = getDbPath(flags.db || flags.path);
  const wantAnswer = flags.answer || flags.a;
  // Default to 15 results for --answer mode to get more context
  const defaultLimit = wantAnswer ? 15 : 5;
  const limit = flags.limit ? Number(flags.limit) : defaultLimit;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('Invalid --limit. Use a positive number.');
  }
  const noExpand = flags['no-expand'] || flags.raw;
  const query = flags._.join(' ');
  if (!query) {
    throw new Error('Provide a query: recall search "your query" [--limit N] [--raw] [--answer]');
  }

  if (noExpand) {
    // Raw FTS5 search without LLM
    const client = new SQLiteClient(dbPath);
    try {
      const results = await client.search(query, Number.isFinite(limit) ? limit : 5);
      console.log(JSON.stringify(results.slice(0, limit), null, 2));
    } finally {
      client.close();
    }
  } else {
    // Full semantic search with LLM expansion + rerank
    await ensureDbDir(dbPath);
    const db = new SQLiteClient(dbPath);
    db.initialize();

    try {
      const provider = (process.env.LLM_PROVIDER || 'cerebras') as any;
      const llm = createLLMProvider({
        provider,
        apiKey: config.cerebrasApiKey() || process.env.LLM_API_KEY,
        model: process.env.LLM_MODEL,
      });
      const useStructured = provider === 'cerebras';
      const expander = new Expander(llm, useStructured);
      const reranker = new Reranker(llm, useStructured);
      const searchSvc = new SearchService(db, expander, reranker);

      // Run search and prepare answer generation in parallel when using --answer
      const searchPromise = searchSvc.search(query, { limit, rerank: true });
      
      if (wantAnswer) {
        // RAG: All search queries run in parallel, then LLM synthesizes answer
        const response = await searchPromise;
        const results = response.results.slice(0, limit);
        const answer = await generateAnswer(llm, query, results);
        console.log(answer);
      } else {
        const response = await searchPromise;
        const results = response.results.slice(0, limit);
        console.log(JSON.stringify(results, null, 2));
      }
    } finally {
      db.close();
    }
  }
}

async function generateAnswer(
  llm: ReturnType<typeof createLLMProvider>,
  query: string,
  results: Array<{ id: string; content: string; score: number }>
): Promise<string> {
  if (results.length === 0) {
    return 'No relevant documents found.';
  }

  // Build context efficiently in parallel (map is already parallelized)
  const contextParts = results.map((r, i) => `[${i + 1}] ${r.content}`);
  const context = contextParts.join('\n\n---\n\n');

  const systemPrompt = `You are a helpful assistant that answers questions based on the provided context.
Use ONLY the information from the context to answer. If the answer is not in the context, say "I cannot find the answer in the provided context."
Be concise and direct. If asked for a specific piece of information (like a name, date, or value), give just that.`;

  const userPrompt = `Context:
${context}

---

Question: ${query}

Answer based ONLY on the context above. Be concise and direct.`;

  try {
    const answer = await llm.complete(userPrompt, systemPrompt);
    return answer.trim() || 'No answer generated.';
  } catch (error) {
    console.error('Error generating answer:', error);
    return 'Error generating answer.';
  }
}

async function deleteCommand(rawArgs: string[]) {
  const flags = parseArgs(rawArgs);
  const dbPath = getDbPath(flags.db || flags.path);
  const id = flags._[0] || (typeof flags.id === 'string' ? flags.id : undefined);
  if (!id) {
    throw new Error('Provide an id: recall delete <id>');
  }
  const client = new SQLiteClient(dbPath);
  try {
    client.delete(id);
    console.log(`Deleted ${id} from ${dbPath}`);
  } finally {
    client.close();
  }
}

async function wipeCommand(rawArgs: string[]) {
  const flags = parseArgs(rawArgs);
  const dbPath = getDbPath(flags.db || flags.path);
  const force = Boolean(flags.force);

  if (!force) {
    const rl = readline.createInterface({ input, output });
    try {
      const answer = await rl.question(`This will delete ALL documents in ${dbPath}. Continue? (y/N): `);
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.log('Aborted.');
        return;
      }
    } finally {
      rl.close();
    }
  }

  const client = new SQLiteClient(dbPath);
  try {
    client.deleteAll();
    console.log(`Wiped all documents in ${dbPath}`);
  } finally {
    client.close();
  }
}

async function statsCommand(rawArgs: string[]) {
  const flags = parseArgs(rawArgs);
  const dbPath = getDbPath(flags.db || flags.path);
  const client = new SQLiteClient(dbPath);
  try {
    const stats = client.stats();
    console.log(JSON.stringify({ dbPath, ...stats }, null, 2));
  } finally {
    client.close();
  }
}

async function indexDoc(doc: {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}) {
  await fetchJson('/index', {
    method: 'POST',
    body: JSON.stringify(doc),
  });
}

async function search(query: string, limit = 5): Promise<SearchResponse> {
  return fetchJson('/search', {
    method: 'POST',
    body: JSON.stringify({ query, limit }),
  });
}

async function seedCommand() {
  console.log('Seeding Recall with test data (33 documents)...');
  const io = await createTestIO(true);
  await ensureLogsDir();
  await io.wipeAll();

  const seedDocs = [
    {
      id: 'conv-001',
      content:
        'We discussed implementing OAuth2 authentication for the new API. The team decided to use JWT tokens for session management. We need to set up an authorization server and configure the redirect URIs properly.',
      metadata: { type: 'meeting', date: '2024-10-15', topic: 'authentication' },
    },
    {
      id: 'conv-002',
      content:
        'The database migration failed because of a foreign key constraint. We need to check the schema and fix the relationships between users and orders tables before retrying.',
      metadata: { type: 'meeting', date: '2024-10-16', topic: 'database' },
    },
    {
      id: 'conv-003',
      content:
        'User reported a bug where the payment processing fails when using credit cards from certain banks. We should add better error handling and retry logic for payment gateway timeouts.',
      metadata: { type: 'support', date: '2024-10-17', topic: 'payments' },
    },
    {
      id: 'conv-004',
      content:
        'The deployment pipeline is taking too long. We discussed moving to a containerized approach with Docker and Kubernetes to speed up builds and enable better scaling.',
      metadata: { type: 'meeting', date: '2024-10-18', topic: 'infrastructure' },
    },
    {
      id: 'conv-005',
      content:
        'We need to implement rate limiting on the API endpoints to prevent abuse. The plan is to use Redis for tracking request counts and implement a sliding window algorithm.',
      metadata: { type: 'meeting', date: '2024-10-19', topic: 'security' },
    },
    {
      id: 'conv-006',
      content:
        'The search functionality is slow because we are doing full table scans. We should add Elasticsearch for better full-text search performance and implement proper indexing strategies.',
      metadata: { type: 'meeting', date: '2024-10-20', topic: 'performance' },
    },
    {
      id: 'conv-007',
      content:
        'Customer wants to export their data in CSV format. We need to build an export feature that handles large datasets efficiently, maybe using background jobs and streaming responses.',
      metadata: { type: 'feature', date: '2024-10-21', topic: 'data-export' },
    },
    {
      id: 'conv-008',
      content:
        'The authentication flow is working but we need to add multi-factor authentication for better security. We will use TOTP codes and integrate with Google Authenticator.',
      metadata: { type: 'meeting', date: '2024-10-22', topic: 'authentication' },
    },
    {
      id: 'conv-009',
      content:
        'We discussed the new feature requirements for the dashboard. Users want to see real-time analytics with charts showing revenue trends, user growth, and conversion rates over time.',
      metadata: { type: 'meeting', date: '2024-10-23', topic: 'dashboard' },
    },
    {
      id: 'conv-010',
      content:
        'The API documentation is out of date. We need to update the OpenAPI spec and regenerate the docs. Also add examples for all endpoints and error responses.',
      metadata: { type: 'task', date: '2024-10-24', topic: 'documentation' },
    },
    {
      id: 'needle-001',
      content:
        'The secret API key for the payment gateway is pk_live_51H3ll0W0r1d_abc123xyz789. Store this securely in environment variables and never commit it to version control. The webhook secret is whsec_4f8b2c9d1e6a3f7b.',
      metadata: { type: 'config', date: '2024-10-25', topic: 'secrets' },
    },
    {
      id: 'needle-002',
      content:
        'The database password for production is SuperSecureP@ssw0rd2024! and the connection string is postgresql://prod:SuperSecureP@ssw0rd2024!@db.prod.internal:5432/maindb. Use connection pooling with max 20 connections.',
      metadata: { type: 'config', date: '2024-10-26', topic: 'database' },
    },
    {
      id: 'needle-003',
      content:
        'The admin email address is admin@company.com and the backup contact is ops@company.com. For emergencies, call the on-call engineer at +1-555-0123. The incident response playbook is in the wiki under Operations/Incidents.',
      metadata: { type: 'contact', date: '2024-10-27', topic: 'support' },
    },
  ];

  const fillerDocs = Array.from({ length: 20 }, (_, idx) => {
    const i = idx + 11;
    return {
      id: `conv-${String(i).padStart(3, '0')}`,
      content:
        'General discussion about project management, code reviews, testing strategies, deployment processes, monitoring and alerting, performance optimization, security best practices, and team collaboration. Various technical topics were covered including microservices architecture, event-driven systems, and cloud infrastructure.',
      metadata: {
        type: 'meeting',
        date: `2024-10-${String(15 + i).padStart(2, '0')}`,
        topic: 'general',
      },
    };
  });

  const allDocs = [...seedDocs, ...fillerDocs];

  await io.indexMany(allDocs);

  const stats = io.mode === 'server' ? await health().catch(() => null) : null;
  console.log('Seed data complete.');
  console.log(
    `Indexed ${allDocs.length} documents${
      stats?.documentCount ? ` (health reports ${stats.documentCount})` : ''
    }.`
  );
  console.log('Needle documents: needle-001, needle-002, needle-003.');
  io.close();
}

async function runTestSuite(
  suiteName: string,
  tests: Array<{ name: string; query: string; expected: string }>,
  searchFn: (query: string, limit?: number) => Promise<SearchResponse>,
  logExpansionQuery?: string
) {
  let passes = 0;

  for (const test of tests) {
    console.log(`TEST: ${test.name}`);
    console.log(`Query: '${test.query}'`);
    console.log(`Expected: ${test.expected}`);

    const result = await searchFn(test.query);
    const found = result.results?.[0]?.id ?? 'null';

    if (found === test.expected) {
      console.log(`PASS: Found ${found}\n`);
      passes += 1;
    } else {
      console.log(`FAIL: Expected ${test.expected}, got ${found}`);
      console.log(
        'Top 3:',
        JSON.stringify(
          (result.results || []).slice(0, 3).map((r) => ({
            id: r.id,
            score: r.score,
          })),
          null,
          2
        )
      );
      console.log('');
    }
  }

  console.log('==============================');
  console.log(`${suiteName} summary: ${passes}/${tests.length} passed`);
  console.log(
    `Accuracy: ${((passes * 100) / tests.length)
      .toFixed(1)
      .replace(/\.0$/, '')}%\n`
  );

  if (logExpansionQuery && passes > 0) {
    const expansion = (await searchFn(logExpansionQuery)).expansion ?? {};
    console.log('Example semantic expansion:');
    console.log(JSON.stringify(expansion, null, 2));
    console.log('');
  }

  return passes;
}

async function needleTestCommand() {
  console.log('Needle in Haystack Accuracy Test');
  console.log('==================================\n');
  const io = await createTestIO(false);
  await ensureLogsDir();

  const tests = [
    {
      name: 'payment gateway API key',
      query: 'what is the payment gateway secret key',
      expected: 'needle-001',
    },
    {
      name: 'database password',
      query: 'production database connection credentials',
      expected: 'needle-002',
    },
    {
      name: 'admin contact',
      query: 'who is the admin email and emergency contact',
      expected: 'needle-003',
    },
  ];

  await runTestSuite('Needle test', tests, io.search, tests[0].query);
  io.close();
}

async function heavySeed(io: TestIO) {
  console.log('1. Clearing database...');
  await io.wipeAll();
  console.log('OK: Database cleared\n');

  console.log('2. Seeding heavy haystack (100+ documents)...');

  const generalDocs = Array.from({ length: 50 }, (_, idx) => {
    const i = idx + 1;
    return {
      id: `haystack-${String(i).padStart(3, '0')}`,
      content:
        'General discussion about software development, project management, code reviews, testing strategies, deployment processes, monitoring and alerting, performance optimization, security best practices, team collaboration, microservices architecture, event-driven systems, cloud infrastructure, containerization, CI/CD pipelines, database design, API development, frontend frameworks, backend services, authentication systems, authorization mechanisms, data processing, analytics, reporting, dashboards, user interfaces, mobile applications, web services, REST APIs, GraphQL endpoints, message queues, caching strategies, load balancing, scaling techniques, and various technical topics.',
      metadata: { type: 'general', index: i },
    };
  });

  const technicalDocs = Array.from({ length: 20 }, (_, idx) => {
    const i = idx + 1;
    return {
      id: `tech-${String(i).padStart(3, '0')}`,
      content:
        'Technical documentation covering implementation details, architectural patterns, design principles, coding standards, testing methodologies, deployment workflows, infrastructure setup, security configurations, performance tuning, optimization techniques, monitoring solutions, logging strategies, error handling, exception management, retry logic, circuit breakers, rate limiting, throttling mechanisms, and various engineering practices.',
      metadata: { type: 'technical', index: i },
    };
  });

  const meetingDocs = Array.from({ length: 20 }, (_, idx) => {
    const i = idx + 1;
    return {
      id: `meeting-${String(i).padStart(3, '0')}`,
      content:
        'Meeting notes from team discussions. Topics included sprint planning, feature development, bug fixes, code reviews, architecture decisions, technology choices, tool evaluation, process improvements, team coordination, stakeholder communication, project timelines, milestone tracking, risk assessment, dependency management, and various organizational topics.',
      metadata: { type: 'meeting', index: i },
    };
  });

  const fillerDocs = Array.from({ length: 10 }, (_, idx) => {
    const i = idx + 1;
    return {
      id: `filler-${String(i).padStart(3, '0')}`,
      content:
        'Documentation about authentication methods, user login processes, password management, session handling, token generation, API key storage, secret management, credential rotation, security policies, access control, permission systems, role-based access, multi-factor authentication, OAuth flows, JWT tokens, and related security topics.',
      metadata: { type: 'filler', index: i },
    };
  });

  const needles = [
    {
      id: 'needle-payment',
      content:
        'The merchant processing service requires the Stripe publishable key pk_live_51H3ll0W0r1d_abc123xyz789 for client-side operations. The server-side secret key sk_live_51H3ll0W0r1d_def456uvw012 must be stored securely in environment variables. Never expose the secret key in client code or version control systems.',
      metadata: { type: 'config', topic: 'payment-processing' },
    },
    {
      id: 'needle-database',
      content:
        'Production data store connection details: host is db.prod.internal, port 5432, database name maindb, username prod, password SuperSecureP@ssw0rd2024!. Use connection pooling with maximum 20 concurrent connections. Connection string format: postgresql://prod:SuperSecureP@ssw0rd2024!@db.prod.internal:5432/maindb',
      metadata: { type: 'config', topic: 'database-access' },
    },
    {
      id: 'needle-contact',
      content:
        'System administrator primary email: admin@company.com. Backup operations contact: ops@company.com. For critical incidents requiring immediate response, contact the on-call engineer at phone number +1-555-0123. Incident response procedures are documented in the Operations wiki under the Incidents section.',
      metadata: { type: 'contact', topic: 'support' },
    },
    {
      id: 'needle-api',
      content:
        'The user authentication service endpoint is located at https://api.company.com/v2/auth/login. This REST API accepts POST requests with JSON payload containing username and password fields. Successful authentication returns a JWT token valid for 24 hours. Rate limiting is set to 5 requests per minute per IP address.',
      metadata: { type: 'api', topic: 'authentication' },
    },
    {
      id: 'needle-webhook',
      content:
        'Stripe webhook signature verification requires the webhook signing secret whsec_4f8b2c9d1e6a3f7b. Store this value in the STRIPE_WEBHOOK_SECRET environment variable. Use this secret to verify webhook payload authenticity by computing HMAC SHA256 signatures.',
      metadata: { type: 'config', topic: 'webhooks' },
    },
    {
      id: 'needle-deploy',
      content:
        'GitHub deployment key for production releases: ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC... (truncated for security). This key has read-only access to the production repository. Configure it in GitHub Settings > Deploy Keys. Never commit this key to version control.',
      metadata: { type: 'config', topic: 'deployment' },
    },
  ];

  const allDocs = [
    ...generalDocs,
    ...technicalDocs,
    ...meetingDocs,
    ...fillerDocs,
    ...needles,
  ];

  await io.indexMany(allDocs);

  console.log(
    `OK: Seeded ${allDocs.length} documents (6 needles hidden in haystack)\n`
  );
}

async function heavyTestCommand() {
  const io = await createTestIO(false);
  await ensureLogsDir();

  await heavySeed(io);

  console.log('4. Running semantic search tests...\n');

  const tests = [
    {
      name: 'payment gateway secret key',
      query: 'what is the Stripe secret key for merchant processing',
      expected: 'needle-payment',
    },
    {
      name: 'database connection credentials',
      query: 'production data store connection password',
      expected: 'needle-database',
    },
    {
      name: 'admin email address',
      query: 'who is the system administrator primary email',
      expected: 'needle-contact',
    },
    {
      name: 'user login API endpoint',
      query: 'where is the user authentication service login endpoint',
      expected: 'needle-api',
    },
    {
      name: 'Stripe webhook signing secret',
      query: 'what is the Stripe webhook signature verification secret',
      expected: 'needle-webhook',
    },
    {
      name: 'deployment key for production releases',
      query: 'GitHub deployment key for production releases',
      expected: 'needle-deploy',
    },
  ];

  await runTestSuite('Heavy test', tests, io.search, tests[0].query);

  io.close();
}

async function chatContextTest() {
  console.log('Chat context test (hard mode)');
  console.log('==============================\n');
  const io = await createTestIO(false);
  await ensureLogsDir();
  await io.wipeAll();

  // 30+ haystack docs with overlapping terminology to confuse keyword search
  const haystackDocs = [
    { id: 'hay-001', content: 'We discussed the new onboarding flow for users. The team wants to add a welcome wizard with profile setup, preferences, and a quick tour.' },
    { id: 'hay-002', content: 'Chat history is stored in SQLite with a per-project DB_PATH. Old threads are archived after 30 days of inactivity.' },
    { id: 'hay-003', content: 'The API rate limits are set to 100 requests per minute per user. Enterprise accounts may request higher limits.' },
    { id: 'hay-004', content: 'For latency we rely on prompt caching and keep rerank on by default; disable rerank only for fast queries.' },
    { id: 'hay-005', content: 'Messages are processed through a queue system. Failed messages retry up to 3 times before being dead-lettered.' },
    { id: 'hay-006', content: 'The dashboard shows real-time analytics including user growth, revenue trends, and conversion rates.' },
    { id: 'hay-007', content: 'Authentication uses JWT tokens with a 24-hour expiry. Refresh tokens last 7 days.' },
    { id: 'hay-008', content: 'We use Redis for session storage and caching. The cache TTL is 5 minutes for most endpoints.' },
    { id: 'hay-009', content: 'Logs are shipped to CloudWatch with a 14-day retention. Critical alerts go to PagerDuty.' },
    { id: 'hay-010', content: 'The team discussed improving search performance by adding better indexing strategies.' },
    { id: 'hay-011', content: 'Customer support tickets are triaged by priority: P0 gets immediate response, P1 within 4 hours, P2 within 24 hours.' },
    { id: 'hay-012', content: 'We plan to migrate the database to Postgres for better scalability. Timeline is Q2 next year.' },
    { id: 'hay-013', content: 'The mobile app uses push notifications for real-time updates. Users can configure notification preferences.' },
    { id: 'hay-014', content: 'Code reviews are required for all PRs. At least one approval is needed before merging.' },
    { id: 'hay-015', content: 'Deployments happen every Tuesday and Thursday at 2pm PST. Hotfixes can be deployed anytime.' },
    { id: 'hay-016', content: 'We use feature flags for gradual rollouts. New features start at 5% and increase over 2 weeks.' },
    { id: 'hay-017', content: 'The billing system processes payments through Stripe. Invoices are generated on the 1st of each month.' },
    { id: 'hay-018', content: 'User data is encrypted at rest using AES-256. Data in transit uses TLS 1.3.' },
    { id: 'hay-019', content: 'The API documentation is auto-generated from OpenAPI specs. Examples are included for all endpoints.' },
    { id: 'hay-020', content: 'We run load tests every month to ensure the system handles 10x normal traffic.' },
    { id: 'hay-021', content: 'The search index is rebuilt nightly. Real-time updates are applied within 5 seconds.' },
    { id: 'hay-022', content: 'Customer feedback is collected via in-app surveys and NPS scores. Results are reviewed weekly.' },
    { id: 'hay-023', content: 'The team uses Slack for communication. Important announcements go to the #general channel.' },
    { id: 'hay-024', content: 'Sprint planning happens every two weeks. Retrospectives are held after each sprint.' },
    { id: 'hay-025', content: 'We have a bug bounty program for security researchers. Payouts range from $100 to $10,000.' },
    { id: 'hay-026', content: 'The staging environment mirrors production. All changes are tested in staging before going live.' },
    { id: 'hay-027', content: 'Error tracking uses Sentry. Critical errors trigger immediate alerts to the on-call engineer.' },
    { id: 'hay-028', content: 'The CDN caches static assets for 1 year. Cache invalidation is manual for emergency updates.' },
    { id: 'hay-029', content: 'User sessions timeout after 30 minutes of inactivity. A warning appears at 25 minutes.' },
    { id: 'hay-030', content: 'The recommendation engine uses collaborative filtering. Model retraining happens weekly.' },
  ];

  // 5 needles hidden in the haystack with specific, unique info
  const needleDocs = [
    {
      id: 'needle-context-window',
      content: 'LLM context window policy for conversation memory: retain exactly 7 user-assistant turns verbatim in the prompt. Older turns are condensed into a compressed rolling summary. Maximum prompt size is 6000 tokens. This controls how many messages the assistant remembers before summarizing.',
    },
    {
      id: 'needle-incident-contacts',
      content: 'Production incident response: primary on-call is maya@ops.io, secondary is chen@ops.io. For severity-1 outages, page both plus the VP of Engineering at vp-eng@company.com.',
    },
    {
      id: 'needle-api-secret',
      content: 'Third-party integration credentials: the Twilio auth token is TWILIO_AUTH_abc123xyz, stored in Vault under path secret/integrations/twilio. Rotate quarterly.',
    },
    {
      id: 'needle-backup-schedule',
      content: 'Database backup cadence: full snapshots every Sunday at 3am UTC, incrementals every 6 hours. Backups retained for 90 days in S3 Glacier.',
    },
    {
      id: 'needle-feature-flag',
      content: 'Beta feature rollout: the experimental text-to-speech engine is controlled by flag enable_tts_beta, currently enabled for 12% of accounts. Plan to expand to 50% next sprint.',
    },
  ];

  const allDocs = [
    ...haystackDocs.map((d) => ({ ...d, metadata: { type: 'chat' } })),
    ...needleDocs.map((d) => ({ ...d, metadata: { type: 'policy' } })),
  ];

  console.log(`Seeding ${allDocs.length} documents (${needleDocs.length} needles hidden)...\n`);

  await io.indexMany(allDocs);

  // Hard queries that require semantic understanding, not keyword matching
  const tests = [
    {
      name: 'LLM context window size',
      query: 'how many turns does the LLM keep in the prompt before condensing',
      expected: 'needle-context-window',
    },
    {
      name: 'incident response contacts',
      query: 'who do I contact for a production outage',
      expected: 'needle-incident-contacts',
    },
    {
      name: 'Twilio credentials location',
      query: 'where is the Twilio authentication token stored',
      expected: 'needle-api-secret',
    },
    {
      name: 'database backup frequency',
      query: 'how often are database backups taken',
      expected: 'needle-backup-schedule',
    },
    {
      name: 'text-to-speech beta rollout',
      query: 'what percentage of accounts have text-to-speech enabled',
      expected: 'needle-feature-flag',
    },
  ];

  await runTestSuite('Chat context test (hard)', tests, io.search, tests[0].query);
  io.close();
}

async function pdfNeedleTest() {
  console.log('PDF needle test');
  console.log('================\n');
  const io = await createTestIO(false);
  await ensureLogsDir();
  await io.wipeAll();

  const docs = [
    {
      id: 'pdf-haystack-001',
      content:
        'This appendix covers deployment pipelines, CI steps, and container builds for the service.',
      metadata: { type: 'pdf', section: 'appendix' },
    },
    {
      id: 'pdf-haystack-002',
      content:
        'Chapter 4 details database migrations, rollback strategy, and seed data initialization.',
      metadata: { type: 'pdf', section: 'chapter-4' },
    },
    {
      id: 'pdf-needle-001',
      content:
        'In Chapter 7 (Needle), the secret access token is tok_live_green_light_alpha_987. This token must be stored in env vars and never committed.',
      metadata: { type: 'pdf', section: 'chapter-7' },
    },
    {
      id: 'pdf-needle-002',
      content:
        'Appendix B lists the incident hotline: +1-555-0101 and the on-call email: oncall@company.com.',
      metadata: { type: 'pdf', section: 'appendix-b' },
    },
  ];

  await io.indexMany(docs);

  const tests = [
    {
      name: 'PDF token',
      query: 'where is the secret access token described in the pdf',
      expected: 'pdf-needle-001',
    },
    {
      name: 'PDF hotline',
      query: 'what is the incident hotline from the appendix',
      expected: 'pdf-needle-002',
    },
  ];

  await runTestSuite('PDF needle test', tests, io.search, tests[0].query);
  io.close();
}

async function showLogsCommand() {
  await ensureLogsDir();
  try {
    const contents = await fs.readFile(logFile, 'utf8');
    const lines = contents.trim().split('\n');
    const total = lines.length;
    const tail = lines.slice(-5);
    console.log(`=== LLM Query Logs (${total} total) ===\n`);
    for (const line of tail) {
      try {
        const entry = JSON.parse(line);
        console.log(
          JSON.stringify(
            {
              query: entry.query,
              actions: entry.plan?.actions?.length ?? 0,
              keywords: entry.expansion?.keywords?.length ?? 0,
              concepts: entry.expansion?.concepts ?? [],
            },
            null,
            2
          )
        );
      } catch {
        console.log(line);
      }
    }
    console.log(`\nFull log: ${logFile}`);
  } catch {
    console.log(`No log file found at ${logFile}`);
    console.log('Run a few searches, then try again.');
  }
}

async function interactiveTestMenu() {
  const rl = readline.createInterface({ input, output });
  try {
    console.log('recall test (interactive)');
    console.log('-------------------------');
    console.log('1) Chat context test');
    console.log('2) PDF needle test');
    console.log('3) Heavy haystack test');
    console.log('q) Quit');
    const answer = await rl.question('Select a test [1-3,q]: ');
    console.log('');

    switch (answer.trim().toLowerCase()) {
      case '1':
        await chatContextTest();
        break;
      case '2':
        await pdfNeedleTest();
        break;
      case '3':
        await heavyTestCommand();
        break;
      case 'q':
      case 'quit':
        console.log('Exiting.');
        break;
      default:
        console.log('Unknown option. Exiting.');
        break;
    }
  } finally {
    rl.close();
  }
}

function printHelp() {
  console.log(`recall CLI

Commands:
  recall serve          Start the Recall HTTP server
  recall init           Create a new local store (DB_PATH or ./recall.sqlite)
  recall index          Index docs locally (--id/--content or batch JSON)
  recall search         Search locally (--answer for AI-generated answer)
  recall delete         Delete a document by id locally
  recall wipe           Delete all documents locally (use --force to skip prompt)
  recall stats          Show document count for the local store
  recall seed           Seed 33-doc test dataset (overwrites DB)
  recall test           Interactive test menu (chat/pdf/heavy)
  recall test:needle    Run light accuracy test (expects seeded data)
  recall test:heavy     Seed 100+ docs then run heavy test
  recall test:all       Run light then heavy tests
  recall logs           Show recent LLM query logs (if any)
  recall show-logs      Alias for logs
  recall help           Show this help

Environment:
  RECALL_URL    Override server URL (default: http://localhost:3000)
  DB_PATH       SQLite path (set before starting the server)
`);
}

async function main() {
  switch (cmd) {
    case 'serve':
      await startServer();
      break;
    case 'seed':
      await seedCommand();
      break;
    case 'init':
      await initCommand(args.slice(1));
      break;
    case 'index':
      await indexCommand(args.slice(1));
      break;
    case 'search':
      await searchCommand(args.slice(1));
      break;
    case 'delete':
      await deleteCommand(args.slice(1));
      break;
    case 'wipe':
      await wipeCommand(args.slice(1));
      break;
    case 'stats':
      await statsCommand(args.slice(1));
      break;
    case 'test':
      await interactiveTestMenu();
      break;
    case 'test:needle':
      await needleTestCommand();
      break;
    case 'test:heavy':
      await heavyTestCommand();
      break;
    case 'test:all':
      await needleTestCommand();
      await heavyTestCommand();
      break;
    case 'show-logs':
    case 'logs':
      await showLogsCommand();
      break;
    case 'help':
    default:
      printHelp();
      if (cmd !== 'help') {
        process.exit(1);
      }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
