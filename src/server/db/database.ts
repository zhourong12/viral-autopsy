import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/** Versioned schema migrations. Append new entries; never edit an applied one. */
export const migrations: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: "initial schema",
    sql: `
      CREATE TABLE datasets (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_name TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('file', 'screenshot', 'paste', 'sample')),
        is_sample INTEGER NOT NULL DEFAULT 0,
        confirmed INTEGER NOT NULL DEFAULT 0,
        posts_json TEXT NOT NULL,
        labels_json TEXT NOT NULL,
        label_source TEXT NOT NULL DEFAULT 'none',
        cover_hints_json TEXT NOT NULL DEFAULT '{}',
        uncertain_json TEXT NOT NULL DEFAULT '{}',
        import_notes_json TEXT NOT NULL DEFAULT '[]',
        as_of TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE analyses (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (mode IN ('ai', 'rules_only')),
        is_sample INTEGER NOT NULL DEFAULT 0,
        report_json TEXT NOT NULL,
        month TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX analyses_created ON analyses (created_at DESC);
      CREATE INDEX analyses_month ON analyses (month, mode);
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reference_id TEXT,
        label TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        cost_usd REAL,
        month TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX usage_events_month ON usage_events (month);
    `,
  },
  {
    version: 2,
    name: "saved column mappings and experiments",
    sql: `
      CREATE TABLE column_mappings (
        platform TEXT NOT NULL,
        signature TEXT NOT NULL,
        assignment_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (platform, signature)
      );
      CREATE TABLE experiments (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        account_name TEXT NOT NULL,
        source_report_id TEXT,
        hypothesis_json TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        metric TEXT NOT NULL,
        started_on TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'finished', 'abandoned')),
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX experiments_created ON experiments (created_at DESC);
    `,
  },
  {
    version: 3,
    name: "porting drafts",
    sql: `
      CREATE TABLE ports (
        id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL,
        month TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX ports_created ON ports (created_at DESC);
    `,
  },
];

export function migrate(db: Db): number[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
      (row) => row.version,
    ),
  );
  const ran: number[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
      ran.push(migration.version);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return ran;
}

export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}
