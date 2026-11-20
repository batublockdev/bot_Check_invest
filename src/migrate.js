/**
 * migrate.js — Run database migrations.
 * Usage: npm run migrate
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', 'migrations');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway')
    ? { rejectUnauthorized: false }
    : undefined,
});

async function runMigrations() {
  // Create migrations tracking table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      executed_at TIMESTAMP DEFAULT NOW()
    );
  `);

  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`[migrate] Found ${files.length} migration files`);

  for (const file of files) {
    const alreadyRun = await pool.query(
      'SELECT 1 FROM _migrations WHERE filename = $1',
      [file]
    );

    if (alreadyRun.rows.length > 0) {
      console.log(`[migrate] Skipping ${file} (already executed)`);
      continue;
    }

    console.log(`[migrate] Running ${file}...`);
    const sql = readFileSync(join(migrationsDir, file), 'utf8');

    try {
      await pool.query('BEGIN');
      await pool.query(sql);
      await pool.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      await pool.query('COMMIT');
      console.log(`[migrate] ✓ ${file} executed successfully`);
    } catch (err) {
      await pool.query('ROLLBACK');
      console.error(`[migrate] ✗ ${file} failed:`, err.message);
      throw err;
    }
  }

  console.log('[migrate] All migrations complete');
  await pool.end();
}

runMigrations().catch((err) => {
  console.error('[migrate] Fatal:', err);
  process.exit(1);
});
