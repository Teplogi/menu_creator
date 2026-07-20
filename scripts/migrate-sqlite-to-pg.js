// SQLite(data.db) の既存データを Postgres(DATABASE_URL) へ移行する一回きりのスクリプト。
//   使い方: .env に DATABASE_URL を設定した上で
//     node scripts/migrate-sqlite-to-pg.js
//   （任意で SQLITE_PATH=別ファイル.db を指定可。既定は data.db）
// 冪等: 主キー等が衝突した行は ON CONFLICT DO NOTHING でスキップするので、再実行しても安全。
import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

const SQLITE_PATH = process.env.SQLITE_PATH || "data.db";
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL が未設定です。.env に Neon 等の接続文字列を設定してください。");
  process.exit(1);
}

const sqlite = new DatabaseSync(SQLITE_PATH);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /neon\.tech|sslmode=require|supabase/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
});

// server.js と同じスキーマ（存在しなければ作成）
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS households (id TEXT PRIMARY KEY, name TEXT, share_token TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS meal_plans (id TEXT PRIMARY KEY, household_id TEXT NOT NULL, start_date TEXT, end_date TEXT, people INTEGER, max_cook_minutes INTEGER, dish_count TEXT, preferences TEXT, avoid TEXT, input_json TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, username_lc TEXT UNIQUE NOT NULL, pw_hash TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS memberships (household_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL, PRIMARY KEY (household_id, user_id));
  CREATE TABLE IF NOT EXISTS pantry_items (id TEXT PRIMARY KEY, household_id TEXT NOT NULL, name TEXT NOT NULL, name_norm TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pantry_hh_norm ON pantry_items (household_id, name_norm);
`;

// テーブル定義: 名前 → カラム順（挿入順は users/households を先に）
const TABLES = [
  ["users", ["id", "username", "username_lc", "pw_hash", "created_at"]],
  ["households", ["id", "name", "share_token", "created_at"]],
  ["memberships", ["household_id", "user_id", "role", "created_at"]],
  ["meal_plans", ["id", "household_id", "start_date", "end_date", "people", "max_cook_minutes", "dish_count", "preferences", "avoid", "input_json", "data_json", "created_at"]],
  ["pantry_items", ["id", "household_id", "name", "name_norm", "created_at"]],
  ["sessions", ["token", "user_id", "created_at"]],
];

async function main() {
  await pool.query(SCHEMA);
  console.log(`移行元: ${SQLITE_PATH} → Postgres`);
  for (const [table, cols] of TABLES) {
    let rows = [];
    try {
      rows = sqlite.prepare(`SELECT ${cols.join(", ")} FROM ${table}`).all();
    } catch (e) {
      console.log(`  ${table}: SQLite側に無いためスキップ`);
      continue;
    }
    let inserted = 0;
    const ph = cols.map((_, i) => `$${i + 1}`).join(", ");
    const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${ph}) ON CONFLICT DO NOTHING`;
    for (const r of rows) {
      const vals = cols.map((c) => r[c]);
      const res = await pool.query(sql, vals);
      inserted += res.rowCount;
    }
    console.log(`  ${table}: ${rows.length}件中 ${inserted}件を挿入（残りは既存でスキップ）`);
  }
  await pool.end();
  console.log("移行完了。");
}

main().catch((e) => {
  console.error("移行に失敗:", e);
  process.exit(1);
});
