import dotenv from 'dotenv';

dotenv.config();

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required env: ${name}`);
  }
  return val;
}

function optional(name: string, fallback?: string): string | undefined {
  const val = process.env[name];
  return val ?? fallback;
}

export const config = {
  cerebrasApiKey: () => optional('CEREBRAS_API_KEY'),
  dbPath: () => optional('DB_PATH', './store/recall.sqlite')!,
  recallUrl: () => optional('RECALL_URL', 'http://localhost:3000')!,
  require: required,
};
