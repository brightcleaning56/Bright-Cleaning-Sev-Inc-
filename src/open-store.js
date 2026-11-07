import { config } from './config.js';
import { Store } from './store.js';

/** Postgres when DATABASE_URL is set; otherwise the pilot JSON file. */
export async function openStore() {
  if (config.databaseUrl) {
    const { PgStore } = await import('./pgstore.js');
    return new PgStore(config.databaseUrl).init();
  }
  const s = new Store(config.dataFile); s.kind = 'file'; return s;
}
