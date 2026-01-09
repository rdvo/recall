import { startServer } from './server-main.js';

startServer().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

export { startServer };

