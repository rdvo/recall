import 'dotenv/config';
import { serve } from '@hono/node-server';
import { SQLiteClient } from './db/sqlite-client.js';
import { Expander } from './expander/index.js';
import { SearchService } from './search/index.js';
import { Reranker } from './search/reranker.js';
import { createServer } from './server.js';
import { createLLMProvider } from './llm/providers.js';
import type { LLMConfig } from './types.js';
import { config } from './config.js';
import fs from 'fs/promises';
import { dirname } from 'path';

const PORT = parseInt(process.env.PORT || '3000', 10);
const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'cerebras') as LLMConfig['provider'];
const LLM_MODEL = process.env.LLM_MODEL;
const DB_PATH = config.dbPath();

export async function startServer(): Promise<void> {
  console.log('Starting Recall server...');

  // Initialize SQLite
  const dbDir = dirname(DB_PATH);
  if (dbDir && dbDir !== '.') {
    await fs.mkdir(dbDir, { recursive: true });
  }
  console.log(`Connecting to SQLite: ${DB_PATH}`);
  const db = new SQLiteClient(DB_PATH);
  db.initialize();
  console.log('SQLite connected');

  // Initialize LLM
  console.log(`Initializing LLM provider: ${LLM_PROVIDER}...`);
  const llmConfig: LLMConfig = {
    provider: LLM_PROVIDER,
    apiKey: config.cerebrasApiKey() || process.env.LLM_API_KEY,
    model: LLM_MODEL
  };
  const llm = createLLMProvider(llmConfig);
  console.log('LLM provider ready');

  // Initialize services
  const useStructured = LLM_PROVIDER === 'cerebras';
  const expander = new Expander(llm, useStructured);
  const reranker = new Reranker(llm, useStructured);
  const search = new SearchService(db, expander, reranker);

  // Create and start server
  const app = createServer(db, search);

  serve(
    {
      fetch: app.fetch,
      port: PORT
    },
    (info) => {
      console.log(`Server running on http://localhost:${info.port}`);
      console.log(`API endpoints:`);
      console.log(`  POST /index    - Index a document`);
      console.log(`  POST /search   - Search (multi-query + rerank by default)`);
      console.log(`  POST /batch    - Bulk index`);
      console.log(`  DELETE /:id    - Delete document`);
      console.log(`  DELETE /_all   - Wipe database`);
      console.log(`  GET /health    - Health check`);
    }
  );
}

