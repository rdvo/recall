import type { Document, SearchResult } from '../types.js';

export interface DatabaseClient {
  initialize(): Promise<void> | void;
  index(doc: Document): Promise<void> | void;
  indexMany(docs: Document[]): Promise<void> | void;
  search(query: string, limit: number): Promise<SearchResult[]>;
  searchWithRegex(pattern: string, limit: number): Promise<SearchResult[]>;
  delete(id: string): Promise<void> | void;
  deleteAll(): Promise<void> | void;
  stats(): Promise<{ documentCount: number }> | { documentCount: number };
  close?(): void;
}

