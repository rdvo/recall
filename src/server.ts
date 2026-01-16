import { Hono } from 'hono';
import type { DatabaseClient } from './db/types.js';
import type { SearchService } from './search/index.js';
import { z } from 'zod';

const indexSchema = z.object({
  id: z.string(),
  content: z.string(),
  metadata: z.record(z.any()).optional()
});

const filterSchema = z.object({
  tags: z.array(z.string()).optional(),
  source: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional()
}).optional();

const searchSchema = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(100).optional(),
  rerank: z.boolean().optional(),
  filters: filterSchema
});

export function createServer(db: DatabaseClient, search: SearchService) {
  const app = new Hono();

  // CORS middleware
  app.use('/*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type');
    if (c.req.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }
    await next();
  });

  app.get('/health', async (c) => {
    try {
      const stats = await db.stats();
      return c.json({ status: 'ok', ...stats });
    } catch (error) {
      return c.json({ status: 'error', error: String(error) }, 500);
    }
  });

  app.post('/index', async (c) => {
    try {
      const body = await c.req.json();
      const data = indexSchema.parse(body);
      
      await db.index({
        id: data.id,
        content: data.content,
        metadata: data.metadata
      });

      return c.json({ success: true, id: data.id });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid request', details: error.errors }, 400);
      }
      return c.json({ error: String(error) }, 500);
    }
  });

  app.post('/search', async (c) => {
    try {
      const body = await c.req.json();
      const data = searchSchema.parse(body);
      
      const result = await search.search(data.query, {
        limit: data.limit,
        rerank: data.rerank,
        filters: data.filters
      });

      return c.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid request', details: error.errors }, 400);
      }
      return c.json({ error: String(error) }, 500);
    }
  });

  app.post('/batch', async (c) => {
    try {
      const body = await c.req.json();
      const items = z.array(indexSchema).parse(body);
      
      await db.indexMany(items.map(item => ({
        id: item.id,
        content: item.content,
        metadata: item.metadata
      })));

      return c.json({ success: true, count: items.length });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid request', details: error.errors }, 400);
      }
      return c.json({ error: String(error) }, 500);
    }
  });

  app.delete('/_all', async (c) => {
    try {
      await db.deleteAll();
      return c.json({ success: true, message: 'All documents deleted' });
    } catch (error) {
      return c.json({ error: String(error) }, 500);
    }
  });

  app.delete('/:id', async (c) => {
    try {
      const id = c.req.param('id');
      await db.delete(id);
      return c.json({ success: true, id });
    } catch (error) {
      return c.json({ error: String(error) }, 500);
    }
  });

  return app;
}

