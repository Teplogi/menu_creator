import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import Anthropic from "@anthropic-ai/sdk";
import Stripe from "stripe";
import webpush from "web-push";
import { OAuth2Client } from "google-auth-library";
import { analyzePlan, foodAliasMap, foodUnitTables } from "./nutrition.js";
import { pickMainCandidates, candidateLine, catalogSize, attachChoice, buildPlanFromCatalog } from "./catalog.js";
import { buildAdvice } from "./nutrition-advice.js";
import { readColumns } from "./columns.js";
import pg from "pg";
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const app = express();
// 本番はリバースプロキシ(Render/Fly等)の背後で動くため、X-Forwarded-* を1ホップ分だけ信頼。
// これにより req.ip が実クライアントIPになり、レート制限が正しく効く。
app.set("trust proxy", 1);

// セキュリティヘッダ。単一HTMLにインラインの<script>/<style>/onclick/データURIを多用しているため、
// CSPは 'unsafe-inline' と data: を許可する実用重視の設定にする（将来的にnonce化を検討）。
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Googleログイン（Google Identity Services）用に accounts.google.com を許可
        scriptSrc: ["'self'", "'unsafe-inline'", "https://accounts.google.com/gsi/client"],
        scriptSrcAttr: ["'unsafe-inline'"], // onclick 等のインラインハンドラを許可（既定の'none'だとUIが壊れる）
        // LPの丸ゴシック（Zen Maru Gothic）を Google Fonts から読むため fonts.* を許可
        styleSrc: ["'self'", "'unsafe-inline'", "https://accounts.google.com/gsi/style", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:", "https://*.googleusercontent.com"],
        connectSrc: ["'self'", "https://accounts.google.com/gsi/"],
        frameSrc: ["'self'", "https://accounts.google.com/gsi/"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
        objectSrc: ["'none'"],
        workerSrc: ["'self'"], // Service Worker（/sw.js）を許可（プッシュ通知/PWA用）
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
        formAction: ["'self'"],
        manifestSrc: ["'self'"],
        upgradeInsecureRequests: null, // localhost(http)開発を壊さないため無効
      },
    },
    // 別オリジンのアイコン等は無いが、将来のCDN埋め込みに備えて緩めに
    crossOriginEmbedderPolicy: false,
    // Googleログインのポップアップ(accounts.google.com)が親ウィンドウへ結果を返せるように。
    // 既定の same-origin だとポップアップ通信が遮断され、白い画面で固まる。
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  })
);
// Stripe Webhook は署名検証に「生ボディ」が必要なため、express.json より前に生パーサで登録する。
// （handleStripeWebhook は関数宣言なので巻き上げにより参照可能）
app.post("/api/billing/webhook", express.raw({ type: "*/*" }), handleStripeWebhook);
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const client = new Anthropic(); // ANTHROPIC_API_KEY を環境変数から読み込む

// ---------- Web Push（プッシュ通知 / PWA） ----------
// VAPID鍵が両方そろっているときだけ通知を有効化する（未設定でもアプリは普通に動く）。
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:peitullysblack@gmail.com";
const pushEnabled = () => !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushEnabled()) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.log("（プッシュ通知は未設定: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 未設定のため無効）");
}

// ---------- Googleログイン（Google Identity Services / IDトークン検証） ----------
// クライアントID（非秘密）が設定されているときだけ有効。秘密鍵は使わない（IDトークンの署名検証のみ）。
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const googleEnabled = () => !!GOOGLE_CLIENT_ID;
const googleClient = googleEnabled() ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
if (!googleEnabled()) console.log("（Googleログインは未設定: GOOGLE_CLIENT_ID 未設定のため無効）");

// ---------- Stripe（課金 / フリーミアム） ----------
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || null;
// 無料ユーザーが月に生成できる「食数」（回数ではなく、生成した食事の数で数える）
const FREE_AI_MEALS_PER_MONTH = Number(process.env.FREE_AI_MEALS_PER_MONTH) || 10;
// AI修正（作り直し・1品差し替え）の無料枠は献立生成とは別枠にする（修正も体験してもらうため）
const FREE_AI_EDITS_PER_MONTH = Number(process.env.FREE_AI_EDITS_PER_MONTH) || 5;
// 課金が有効なのは「秘密鍵」と「価格ID」が両方そろっているときだけ。
// 未設定の間は AI 生成を全ユーザーに開放する（開発・公開前でも普通に使える）。
const billingEnabled = () => !!(stripe && STRIPE_PRICE_ID);
if (!billingEnabled()) {
  console.log("（課金は未設定: STRIPE_SECRET_KEY / STRIPE_PRICE_ID 未設定のため、AI生成は全開放されます）");
}

const currentYM = () => new Date().toISOString().slice(0, 7); // "YYYY-MM"
// プレミアム扱いか（課金未設定の環境では全員プレミアム扱い＝開発時に詰まらないように）
const hasAi = async (userId) => (billingEnabled() ? await hasActiveEntitlement(userId) : true);
async function hasActiveEntitlement(userId) {
  const e = await one("SELECT status, current_period_end FROM entitlements WHERE user_id = $1", [userId]);
  if (!e || e.status !== "active") return false;
  if (e.current_period_end && e.current_period_end < new Date().toISOString()) return false;
  return true;
}
// { meals, edits } を返す（meals=献立生成の食数、edits=AI修正の回数）
async function getAiUsage(userId) {
  const r = await one("SELECT count, edit_count FROM ai_usage WHERE user_id = $1 AND ym = $2", [userId, currentYM()]);
  return { meals: r ? r.count : 0, edits: r ? r.edit_count : 0 };
}
// kind="meal" は count、"edit" は edit_count を加算する。
async function incAiUsage(userId, n = 1, kind = "meal") {
  const col = kind === "edit" ? "edit_count" : "count";
  await q(
    `INSERT INTO ai_usage (user_id, ym, ${col}) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, ym) DO UPDATE SET ${col} = ai_usage.${col} + $3`,
    [userId, currentYM(), n]
  );
}
// リクエストから「生成する食数」を数える（targets の slots 合計）
function aiCostFromTargets(targets) {
  if (!Array.isArray(targets)) return 1;
  const n = targets.reduce((sum, t) => sum + (Array.isArray(t?.slots) ? t.slots.length : 0), 0);
  return Math.max(1, n);
}
// AI利用ゲート（auth の後段に置く）。課金未設定=全開放、加入済み=無制限、
// 無料=月 FREE_AI_MEALS_PER_MONTH「食」まで。costFn(req) が今回生成する食数を返す。
// 「残り枠 < 今回の食数」なら生成前に 402 で止める（大量生成を無料で取られる穴を塞ぐ）。
// 消費はここではせず、各ハンドラが「成功時のみ」 incAiUsage(userId, req.aiCost) する。
function requireAi(costFn, kind = "meal") {
  return async (req, res, next) => {
    try {
      if (!billingEnabled()) { req.aiPaid = true; return next(); }
      if (await hasActiveEntitlement(req.user.id)) { req.aiPaid = true; return next(); }
      const cost = Math.max(1, costFn ? costFn(req) : 1);
      const usage = await getAiUsage(req.user.id);
      const limit = kind === "edit" ? FREE_AI_EDITS_PER_MONTH : FREE_AI_MEALS_PER_MONTH;
      const used = kind === "edit" ? usage.edits : usage.meals;
      const remaining = Math.max(0, limit - used);
      const unit = kind === "edit" ? "回" : "食";
      const label = kind === "edit" ? "AI修正" : "AI献立生成";
      if (cost > remaining) {
        return res.status(402).json({
          code: "UPGRADE_REQUIRED",
          error:
            remaining <= 0
              ? `今月の無料${label}（${limit}${unit}）を使い切りました。プレミアムにアップグレードすると使い放題です。`
              : `今回（${cost}${unit}分）は無料枠の残り（${remaining}${unit}）を超えます。プレミアムなら使い放題です。`,
          freeLimit: limit,
          freeRemaining: remaining,
          requested: cost,
        });
      }
      req.aiPaid = false;
      req.aiCost = cost;
      req.aiKind = kind;
      return next();
    } catch (err) {
      handleError(res, err);
    }
  };
}
async function getOrCreateStripeCustomer(user) {
  const e = await one("SELECT stripe_customer_id FROM entitlements WHERE user_id = $1", [user.id]);
  if (e?.stripe_customer_id) return e.stripe_customer_id;
  const customer = await stripe.customers.create({ name: user.username, metadata: { userId: user.id } });
  await q(
    `INSERT INTO entitlements (user_id, provider, status, stripe_customer_id, updated_at)
     VALUES ($1, 'stripe', 'inactive', $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id, updated_at = EXCLUDED.updated_at`,
    [user.id, customer.id, new Date().toISOString()]
  );
  return customer.id;
}

// ---------- レート制限 ----------
const jsonTooMany = (msg) => (req, res) => res.status(429).json({ error: msg });
// ログイン/登録: 総当たり・大量アカウント作成の抑止（IP単位）
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonTooMany("試行回数が多すぎます。しばらく時間をおいてから再度お試しください。"),
});
// AI生成系: コスト暴走・乱用の抑止（ログインユーザー単位、未認証時はIP）
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.AI_RATE_LIMIT_PER_HOUR) || 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
  handler: jsonTooMany("AI生成のご利用が短時間に集中しています。1時間ほど時間をおいてからお試しください。"),
});

const MAX_DAYS = 14;
const MAX_SLOTS = 42; // 生成量の上限（14日 × 3食）

// ---------- DB（Postgres / pg） ----------
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL が未設定です。.env に接続文字列を設定してください（Neon/Supabase）。");
}
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon 等のマネージドPostgresはSSL必須
  ssl: /neon\.tech|sslmode=require|supabase/.test(process.env.DATABASE_URL || "")
    ? { rejectUnauthorized: false }
    : undefined,
  max: 8,
});
pool.on("error", (err) => console.error("PG pool error:", err.message));

// クエリヘルパー（$1, $2 ... のプレースホルダを使う）
const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
const all = async (text, params) => (await pool.query(text, params)).rows;

// スキーマ（各文を個別に実行する。CREATE TABLE IF NOT EXISTS はPostgresで競合すると
// pg_type の重複エラーを出すことがあるため、良性エラーは握りつぶす）
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY, name TEXT, share_token TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS meal_plans (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL, start_date TEXT, end_date TEXT,
    people INTEGER, max_cook_minutes INTEGER, dish_count TEXT, preferences TEXT, avoid TEXT,
    input_json TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, username_lc TEXT UNIQUE NOT NULL,
    pw_hash TEXT NOT NULL, created_at TEXT NOT NULL)`,
  // 表示名（アプリ内で表示。ログイン用 username とは別。未設定なら username にフォールバック）
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT`,
  // Googleログイン: google_sub（Googleの一意ID）・email。Google専用ユーザーは pw_hash が NULL。
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`,
  `ALTER TABLE users ALTER COLUMN pw_hash DROP NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users (google_sub)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expires_at TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at)`,
  `CREATE TABLE IF NOT EXISTS memberships (
    household_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
    created_at TEXT NOT NULL, PRIMARY KEY (household_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS pantry_items (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL, name TEXT NOT NULL, name_norm TEXT NOT NULL,
    created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_pantry_hh_norm ON pantry_items (household_id, name_norm)`,
  // 要望テンプレ（作成画面の「要望」欄に入れる定型文。グループ共有）
  `CREATE TABLE IF NOT EXISTS preference_presets (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_presets_hh ON preference_presets (household_id, created_at)`,
  // お気に入りレシピ（グループ共有）。dish_json=料理のスナップショット（材料・作り方）。
  // NULL なら「名前だけ」のお気に入り（レシピ不要の十八番）。
  `CREATE TABLE IF NOT EXISTS favorite_dishes (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL, name TEXT NOT NULL, name_norm TEXT NOT NULL,
    role TEXT, dish_json TEXT, created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_fav_hh_norm ON favorite_dishes (household_id, name_norm)`,
  // 冷蔵庫・作り置き（グループ共有・短命の在庫）。kind: 'ingredient'=食材 / 'prepped'=作り置き。
  // amount はざっくり任意（「半分」「少し」等）。常備品(pantry)＝定常在庫とは役割が別。
  `CREATE TABLE IF NOT EXISTS fridge_items (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL, name TEXT NOT NULL, name_norm TEXT NOT NULL,
    kind TEXT NOT NULL, amount TEXT, created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_fridge_hh_kind_norm ON fridge_items (household_id, kind, name_norm)`,
  // 食材の設定（kind: 'avoid'=使わない / 'soft'=控えめ。'easy'/'hard' は旧仕様）
  `CREATE TABLE IF NOT EXISTS store_items (
    id TEXT PRIMARY KEY, household_id TEXT NOT NULL, name TEXT NOT NULL, name_norm TEXT NOT NULL,
    kind TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_store_hh_kind_norm ON store_items (household_id, kind, name_norm)`,
  `CREATE INDEX IF NOT EXISTS idx_plans_household ON meal_plans (household_id, created_at DESC)`,
  // 課金: 加入状態（provider 列で将来 RevenueCat 等も同居可能）
  `CREATE TABLE IF NOT EXISTS entitlements (
    user_id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'stripe',
    status TEXT NOT NULL DEFAULT 'inactive', plan TEXT,
    stripe_customer_id TEXT, stripe_subscription_id TEXT,
    current_period_end TEXT, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_entitlements_customer ON entitlements (stripe_customer_id)`,
  // 無料枠カウンタ（ユーザー×年月）。count=献立生成の食数、edit_count=AI修正の回数（別枠）。
  `CREATE TABLE IF NOT EXISTS ai_usage (
    user_id TEXT NOT NULL, ym TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, ym))`,
  `ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS edit_count INTEGER NOT NULL DEFAULT 0`,
  // プッシュ通知: 端末ごとの購読情報（1ユーザーが複数端末を持てる）
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_push_sub_user ON push_subscriptions (user_id)`,
  // プッシュ通知: 種類ごとのON/OFF（ユーザー単位。既定は全ON）
  `CREATE TABLE IF NOT EXISTS notification_prefs (
    user_id TEXT PRIMARY KEY,
    dinner_reminder BOOLEAN NOT NULL DEFAULT true,
    plan_reminder BOOLEAN NOT NULL DEFAULT true,
    member_update BOOLEAN NOT NULL DEFAULT true,
    updated_at TEXT NOT NULL)`,
  // 定期通知の二重送信防止（user×種類×日/週キー）
  `CREATE TABLE IF NOT EXISTS push_sent_log (
    user_id TEXT NOT NULL, kind TEXT NOT NULL, day TEXT NOT NULL,
    PRIMARY KEY (user_id, kind, day))`,
  // 毎週おまかせ作成（プレミアム）。時刻・曜日はすべて日本時間で持つ。
  `CREATE TABLE IF NOT EXISTS auto_plans (
    household_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT false,
    weekday INTEGER NOT NULL DEFAULT 0,
    hour INTEGER NOT NULL DEFAULT 18,
    days INTEGER NOT NULL DEFAULT 7,
    slots TEXT NOT NULL DEFAULT '夕食',
    weekdays_only BOOLEAN NOT NULL DEFAULT false,
    opts_json TEXT,
    last_run TEXT,
    last_status TEXT,
    updated_at TEXT NOT NULL)`,
  // 曜日ごとに作る食事（{"0":["昼食","夕食"],"1":["夕食"]}）。無い曜日は作らない。
  `ALTER TABLE auto_plans ADD COLUMN IF NOT EXISTS dow_slots TEXT`,
];
async function initDb() {
  for (const sql of SCHEMA_STATEMENTS) {
    try {
      await q(sql);
    } catch (e) {
      // 既に存在する場合の良性エラー（IF NOT EXISTS の競合など）は無視
      if (/already exists|pg_type_typname|duplicate key value violates unique constraint "pg_/i.test(e.message)) continue;
      throw e;
    }
  }
}

// 食材名の正規化（表記ゆれ吸収。フロントの normName と揃える）
function normName(s) {
  return (s || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

// ---------- 認証ヘルパー ----------
function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}
function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = (stored || "").split(":");
  if (!saltHex || !hashHex) return false;
  const hash = Buffer.from(hashHex, "hex");
  const test = scryptSync(pw, Buffer.from(saltHex, "hex"), 64);
  return hash.length === test.length && timingSafeEqual(hash, test);
}
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS) || 30;
async function createSession(userId) {
  const token = randomBytes(24).toString("base64url");
  const now = Date.now();
  await q("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)", [
    token,
    userId,
    new Date(now).toISOString(),
    new Date(now + SESSION_TTL_DAYS * 86400000).toISOString(),
  ]);
  return token;
}
// 認証必須ミドルウェア（req.user をセット）
async function auth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    const sess = token ? await one("SELECT * FROM sessions WHERE token = $1", [token]) : null;
    // 有効期限切れセッションは無効化（掃除して401）。expires_at が無い旧行は期限なし扱い。
    if (sess && sess.expires_at && sess.expires_at < new Date().toISOString()) {
      await q("DELETE FROM sessions WHERE token = $1", [token]).catch(() => {});
      return res.status(401).json({ error: "セッションの有効期限が切れました。再度ログインしてください。" });
    }
    const user = sess ? await one("SELECT id, username, display_name FROM users WHERE id = $1", [sess.user_id]) : null;
    if (!user) return res.status(401).json({ error: "ログインが必要です。" });
    req.user = user;
    next();
  } catch (err) {
    handleError(res, err);
  }
}
async function isMember(userId, householdId) {
  return !!(await one("SELECT 1 FROM memberships WHERE user_id = $1 AND household_id = $2", [userId, householdId]));
}
// req.user が householdId のメンバーであることを要求。OKなら household 行を返す
async function requireMember(req, res, householdId) {
  const hh = await one("SELECT * FROM households WHERE id = $1", [householdId]);
  if (!hh) { res.status(404).json({ error: "グループが見つかりません。" }); return null; }
  if (!(await isMember(req.user.id, hh.id))) { res.status(403).json({ error: "このグループへのアクセス権がありません。" }); return null; }
  return hh;
}

// ---------- 生成スキーマ（tool の input_schema） ----------
const INGREDIENT = {
  type: "object",
  properties: {
    name: { type: "string", description: "食材名（例: 鶏もも肉）" },
    amount: { type: "string", description: "分量（例: 300g）" },
    category: {
      type: "string",
      description:
        "分類。必ず次のいずれか: 野菜・果物 / 肉・魚 / 卵・乳・豆腐 / 主食・乾物 / 調味料 / その他。醤油・塩・砂糖・みりん・酒・酢・味噌・油・だし・こしょう等の常備調味料、および水・お湯は必ず「調味料」にする。",
    },
  },
  required: ["name", "amount", "category"],
  additionalProperties: false,
};
const DISH = {
  type: "object",
  properties: {
    role: { type: "string", description: "主菜 / 副菜 / 汁物 のいずれか" },
    main_type: {
      type: "string",
      description: "主菜のときだけ入れる、その料理の主材料の種類。必ず次のいずれか: 肉 / 魚 / 卵・豆腐 / 野菜。副菜・汁物では省略してよい。",
    },
    name: { type: "string", description: "料理名" },
    description: { type: "string", description: "ひとこと説明" },
    cook_minutes: { type: "integer", description: "調理時間の目安（分）" },
    ingredients: { type: "array", items: INGREDIENT },
    steps: { type: "array", items: { type: "string" }, description: "作り方の手順" },
  },
  required: ["role", "name", "description", "cook_minutes", "ingredients", "steps"],
  additionalProperties: false,
};
const MEAL_PLAN_SCHEMA = {
  type: "object",
  properties: {
    days: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
          meals: {
            type: "array",
            items: {
              type: "object",
              properties: {
                slot: { type: "string", description: "朝食 / 昼食 / 夕食" },
                dishes: { type: "array", items: DISH },
              },
              required: ["slot", "dishes"],
              additionalProperties: false,
            },
          },
        },
        required: ["date", "meals"],
        additionalProperties: false,
      },
    },
  },
  required: ["days"],
  additionalProperties: false,
};

const DISH_COUNT_DIRECTIVE = {
  main: "各食事は主菜を1品だけ作る。",
  main_side: "各食事は主菜1品と副菜1品を作る。",
  main_side_soup: "各食事は主菜1品・副菜1品・汁物1品を作る。",
  main_soup: "各食事は主菜1品と汁物1品を作る（副菜は作らない）。",
  main_side2: "各食事は主菜1品と副菜2品を作る。副菜2品は食材・味付け・調理法が重ならないように組み合わせる。",
  main_side2_soup: "各食事は主菜1品・副菜2品・汁物1品を作る。副菜2品は食材・味付け・調理法が重ならないように組み合わせる。",
};
// 使ってよい主食。画面からは配列（["rice","noodle"] 等）で来る。空＝おまかせ（全部あり）。
const STAPLE_NAME = { rice: "ご飯", noodle: "麺類", bread: "パン" };
const STAPLE_ONLY = {
  rice: "主食はご飯（白米）を前提にし、それに合う主菜（おかず）にする。",
  noodle: "主食は麺類にする。主菜は麺料理そのもの（ラーメン・うどん・そば・パスタ・焼きそば・冷やし中華 等）にする。品数が少ない場合は一皿で完結してよい。",
  bread: "主食はパン。ご飯前提の和風のおかず（生姜焼き・照り焼き・煮物・焼き魚など）は選ばず、パンに合う洋風の献立にする。主菜は、パンそのものを主役にした料理（サンドイッチ・ピザトースト・フレンチトースト・ホットドッグ・パングラタン等）か、パンに添える洋風料理（シチュー・ポトフ・スープ・オムレツ・ソーセージ・グラタン等）にする。パンやその材料も材料リストに含める。",
};
const STAPLE_ALL = "主食は指定なし。基本はご飯だが、麺類・パン・丼ものの日も適度に混ぜて、毎日ご飯に偏らないようにする（マンネリ回避）。";
function stapleDirective(list) {
  const on = (Array.isArray(list) ? list : []).filter((v) => STAPLE_NAME[v]);
  if (!on.length || on.length === 3) return STAPLE_ALL;
  if (on.length === 1) return STAPLE_ONLY[on[0]];
  const off = Object.keys(STAPLE_NAME).filter((v) => !on.includes(v)).map((v) => STAPLE_NAME[v]);
  return `主食は ${on.map((v) => STAPLE_NAME[v]).join("・")} のどれかにし、日によって変える。${off.join("・")}は使わない。`;
}
// 旧形式（"any" / "rice" のような文字列）で来ても動くようにしておく
const normalizeStaple = (v) =>
  Array.isArray(v) ? v.filter((x) => STAPLE_NAME[x]) : STAPLE_NAME[v] ? [v] : [];

// ---------- 生成ロジック ----------
function buildPrompt(targets, opts, { avoidDishes = [], recentDishes = [], recentSlotDishes = [], styleHint = "", mainHint = "", sideHint = "", fridgeDishHint = "", storeAvoid = [], storeSoft = [], mainCandidates = [], sameDayDishes = [] } = {}) {
  const { people, maxCookMinutes, dishCount, staple, preferences, avoid } = opts;
  const includeSteps = opts.includeSteps !== false;
  const targetLines = targets
    .map((t) => `- ${t.date} : ${t.slots.join(" / ")}`)
    .join("\n");

  return [
    "あなたは共働き家庭向けの時短献立プランナーです。以下の条件で日ごとの献立を作成してください。",
    "",
    "対象（この日付・食事の組み合わせちょうどで days / meals を作成すること）:",
    targetLines,
    "",
    `人数: ${people}人分（材料の分量は人数に合わせる）`,
    DISH_COUNT_DIRECTIVE[dishCount] || DISH_COUNT_DIRECTIVE.main_side,
    stapleDirective(staple),
    maxCookMinutes
      ? `各料理は調理時間の目安が ${maxCookMinutes} 分以内になるようにし、cook_minutes に目安（分）の数値を入れる。`
      : "各料理の cook_minutes に調理時間の目安（分）の数値を入れる。",
    preferences ? `好み・要望: ${preferences}` : "好み・要望: 特になし（栄養バランスよく、和洋中を織り交ぜる）",
    opts.guided?.mains ? `主菜のバランス指定: ${opts.guided.mains}（期間全体でこの配分を守る）` : "",
    (opts.guided?.cooking || []).includes("揚げ物なし") ? "調理法の指定: 揚げ物は作らない（唐揚げ・フライ・天ぷら・揚げ焼きも避ける）。" : "",
    (opts.guided?.cooking || []).includes("レンジ・時短中心") ? "調理法の指定: 電子レンジ活用や炒め・和えものなどの時短調理を中心にし、洗い物が少なく済むようにする。" : "",
    // 主菜は候補の絞り込みでも効かせているが、副菜・汁物は自由生成なので言葉でも伝える
    ...(opts.guided?.style || []).map((s) => ({
      "子どもも食べやすい": "好みの指定: 小さい子どもでも食べやすい料理にする（強い辛さ・クセの強い食材・骨のある魚は避ける）。",
      "辛いものなし": "好みの指定: 辛い料理は作らない（豆板醤・キムチ・カレー粉・唐辛子を効かせたものを避ける）。",
      "作り置きしたい": "好みの指定: 作り置きや翌日のお弁当に回しやすい料理を選ぶ（冷めてもおいしいもの、日持ちするもの）。",
      "洗い物少なめ": "好みの指定: 使う調理器具が少なくて済む料理にする（フライパン1つ・レンジだけ、など）。",
      "節約したい": "好みの指定: 材料費が抑えられる料理にする（もやし・豆腐・鶏むね肉・卵・旬の野菜などを活かす）。高価な食材は使わない。",
    }[s] || "")),
    avoid ? `避けたい食材・アレルギー: ${avoid}（絶対に使用しない）` : "",
    storeAvoid && storeAvoid.length
      ? `次の食材はアレルギー・苦手のため、料理・材料に一切使わないこと（絶対）: ${storeAvoid.join("、")}`
      : "",
    storeSoft && storeSoft.length
      ? `次の食材は入手しにくいので、できるだけ使わないでください（基本は控える。他に適切な選択肢が無いときだけ、たまに使うのは可）: ${storeSoft.join("、")}`
      : "",
    avoidDishes && avoidDishes.length
      ? `次の料理名とは重複させないこと: ${avoidDishes.join("、")}`
      : "",
    recentDishes && recentDishes.length
      ? `この世帯で最近（ここ2〜3週間）作った主菜です。同じ・似た主菜が続くとマンネリになるので、これらとは違う主菜（別の主材料・調理法）にすること（特に重要）: ${recentDishes.join("、")}`
      : "",
    fridgeDishHint
      ? `★この食事の主菜は、冷蔵庫の残り食材をまとめて使い切る「${fridgeDishHint}」にすること（最優先の指定。一般家庭の定番の作り方で）。`
      : "",
    mainHint
      ? `★主菜の主材料は必ず「${mainHint}」にすること（今回の主菜はこの主材料で作る。これは最優先の指定。副菜・汁物はこの限りではない）。`
      : "",
    // 条件（時間・主食・避けたい食材など）を満たす料理をこちらで絞り込んである。
    // その中から要望に一番合うものを選んでもらう＝変な創作料理が出ず、約束も守られる。
    mainCandidates && mainCandidates.length
      ? [
          "★主菜は、次の候補から1つ選ぶこと（すべて今回の条件を満たしています）:",
          mainCandidates.join(" / "),
          "- ユーザーの好み・要望に一番合うものを選ぶ。同じ条件でも毎回同じ料理に寄らないよう、候補の中から幅をもって選ぶ。",
          "- 候補に合うものが無い場合（要望が具体的で、どれも当てはまらないときだけ）は、候補外の料理にしてよい。",
          "- 料理名は候補のままにする。材料と作り方は、一般家庭の定番の作り方でこちらで書き起こすこと。",
        ].join("\n")
      : "",
    sideHint
      ? `★副菜を作る場合は「${sideHint}」系にすること（主菜と食材・味付けが被らないように）。`
      : "",
    // 同じ日に2食以上あるとき、昼と夕で食材が丸かぶりしないようにする
    sameDayDishes && sameDayDishes.length
      ? `同じ日の他の食事では「${sameDayDishes.join("」「")}」を作ります。1日のうちで食材が重なると飽きるので、主菜・副菜とも使う食材をできるだけ変えること。`
      : "",
    recentSlotDishes && recentSlotDishes.length
      ? `最近この食事枠で出した料理です（直近30日）。マンネリ防止のため、主菜・副菜ともこれらと同じ・ほぼ同じ料理は出さないこと: ${recentSlotDishes.join("、")}` +
        "（例外: ユーザーの要望に「同じ料理をくり返してよい」「この料理を毎週入れたい」等の指定があれば、要望を優先してよい）"
      : "",
    styleHint
      ? `参考の方向性: 今回は「${styleHint}」寄りで、他と被らない一皿を歓迎します（絶対条件ではありません）。`
      : "",
    "",
    "【バリエーションのルール（重要）】",
    "- 主菜の主材料を分散させる（肉類・魚介・卵・大豆製品・野菜中心などを偏らせない）。連日で同じ主材料を続けない。",
    "- 調理法を分散させる（焼く・煮る・炒める・揚げる・蒸す・和える 等をローテーション）。",
    "- ジャンルを織り交ぜる（和食・洋食・中華 を中心に。エスニックは控えめに）。",
    "- 味付けが単調にならないようにする（醤油ベースばかりにしない）。",
    "",
    // 卵・豆腐は「主菜1品」で成立しないことがあり、テスターからも物足りないと感じられやすい。
    // 夕食だけは、肉・ひき肉・魚介と組み合わせてボリュームを出すよう明示する。
    "【卵・豆腐を主菜にするときのルール】",
    targets.some((t) => (t.slots || []).includes("夕食"))
      ? [
          "- 夕食の主菜を卵・豆腐・厚揚げにするときは、それだけで完結させない。肉・ひき肉・魚介などを組み合わせて、主菜として食べごたえのある一皿にする。",
          "  例) ○ 麻婆豆腐 / 肉豆腐 / 豆腐ハンバーグ / 厚揚げと豚肉の味噌炒め / 豚肉入りのニラ玉 / 親子丼 / 豆腐チャンプルー",
          "  　　× プレーンオムレツだけ / 目玉焼きだけ / 冷奴だけ / 湯豆腐だけ / 具のない卵とじ",
        ].join("\n")
      : "- 朝食・昼食なら、卵焼き・オムレツ・目玉焼き・冷奴のような軽い卵・豆腐料理を主菜にしてよい。",
    "",
    "【親しみやすさのルール（最重要）】",
    "- 一般家庭でよく作られる『定番の料理』を中心にする。オムライス・焼きそば・ハンバーグ・生姜焼き・肉じゃが・カレー・唐揚げ・麻婆豆腐・親子丼・野菜炒め・鮭の塩焼き・餃子・グラタン のような、名前を聞いてすぐ分かる料理を積極的に入れる。",
    "- 奇をてらった創作料理、手の込みすぎた料理、レストランのような凝った一皿は避ける（毎日の家庭の食卓向け）。",
    "- 料理名は短くシンプルな一般名にする。カッコ書きの外国語名・地名・凝った風味説明（『〜風』『〜ソース』『〜添え』『〜仕立て』など）は付けない。",
    "  例) ○「鶏のトマト煮込み」「キャベツとコーンのサラダ」　×「ポッレッロ・アル・ポモドーロ風」「キャベツとコーンのサラダ（粒マスタード風味）」",
    "",
    opts.fridgeUse && opts.fridgeUse.length
      ? [
          "【冷蔵庫の使い切り（重要）】",
          `- いま冷蔵庫に残っている食材: ${opts.fridgeUse.map((f) => f.name + (f.amount ? `(${f.amount})` : "")).join("、")}`,
          "- これらを積極的に使う（量の表記はざっくりの目安）。ただし★主菜の指定（料理・主材料）がある場合はそちらが優先。",
          "- 主材料の指定と合わない食材は、副菜・汁物・付け合わせで活用するか、この食事では使わなくてよい（毎食すべてに詰め込まず、バリエーションを保つ）。",
          "- 食材を無理に組み合わせた不自然な創作料理（例: 豆腐のオムレツ）は作らない。使うなら定番の使い方で。",
        ].join("\n")
      : "",
    "",
    "【食材を使い切るルール（重要）】",
    "- 余りやすい食材（白菜・大根・キャベツ・長ねぎ・にんじん・きのこ・豆腐・ひき肉など、1回で使い切りにくいもの）は、期間内の複数の献立で使い回して使い切るように計画する。",
    "- 生鮮食品（葉物野菜・魚など傷みやすいもの）は期間の前半に、日持ちする食材（根菜・乾物・冷凍可のもの）は後半に寄せる。",
    "- 特売でまとめ買いしやすい食材を、無駄が出ない範囲で活用する。",
    "",
    "【分量表記のルール（重要）】",
    "- 野菜・果物・豆腐など個数で数えられる食材は、必ず「個数(目安の重量g)」の形式で書く。例: 玉ねぎ 1/2個(100g)、にんじん 1/3本(50g)、キャベツ 1/4個(300g)、豆腐 1/2丁(150g)。",
    "- 個数の単位は 個・本・枚・袋・束・株・丁・かけ など食材に合った自然なものを使い、数は 1/4・1/3・1/2・1・2 のようなきれいな整数か分数にする。野菜に「120g」のようなgだけの表記は使わない。",
    "- 肉・魚は「200g」「2切れ(160g)」のように重量を基本にする。調味料は 大さじ・小さじ・少々。",
    "- 同じ食材はどの料理でも同じ単位で書く（玉ねぎを「個」と「g」で混在させない）。",
    "- にんにく・しょうがは「1かけ(5g)」「1かけ(15g)」のように必ず「かけ」で書く（「片」「小さじ」「すりおろし小さじ1」は使わない）。",
    "- 食材名の書き方も統一する。ひらがな・カタカナ・漢字を混ぜない。○ にんにく／にんじん／しょうが／玉ねぎ／じゃがいも／ねぎ　× ニンニク／人参／生姜／タマネギ／ジャガイモ。",
    "",
    "【魚・サラダの書き方（入手しやすさ優先）】",
    "- 魚の種類を変えても成立する料理（塩焼き・照り焼き・ムニエル・フライ・煮付け・南蛮漬け・刺身など）は、料理名にも材料にも魚の種類を書かない。近所のスーパーに特定の魚が無いことがあるため、ユーザーが後で種類を選べるようにする。",
    "  例) ○「焼き魚」 ×「鮭の塩焼き」／ ○「魚の照り焼き」 ×「ブリの照り焼き」／ ○「白身魚のムニエル」 ×「たらのムニエル」／ ○「お刺身」 ×「まぐろの刺身」。",
    "  材料も同様に「魚の切り身 2切れ(160g)」「刺身用の魚 1パック」と書く（×「鮭の切り身」「ブリの切り身」）。",
    "- 例外は魚種と料理名が一体化した次の定番のみ: さばの味噌煮 / ぶり大根 / 鮭のちゃんちゃん焼き / あじフライ。これらはその魚種のままでよい。",
    "- サラダは手に入りやすい定番野菜（レタス・キャベツ・トマト・きゅうり・玉ねぎ・にんじん等）で作る。珍しい野菜や特殊な葉物は指定しない。",
    "",
    "その他のルール:",
    "- 各 dish の role は「主菜」「副菜」「汁物」のいずれかにする。",
    "- 主菜には main_type（肉 / 魚 / 卵・豆腐 / 野菜 のいずれか）を必ず入れる。その料理の主材料に当たるものを選ぶ。",
    "- 材料は name（食材名）・amount（分量）・category（分類）に分ける。category は指定の6分類から正しく選び、常備調味料は必ず「調味料」にする。",
    includeSteps
      ? "- 手順は簡潔な箇条書きにする。"
      : "- このプランは献立（料理名・材料）だけでよく、作り方の手順は不要です。",
    "- すべて日本語で出力する。",
  ]
    .filter(Boolean)
    .join("\n");
}

// まとめ生成の既定モデル（品質重視）。単発操作・順次表示は速い Haiku を使う。
// 既定は全面 Haiku（品質は検証済みで実運用の stream 生成も元々 Haiku、コスト最安・高速）。
// 品質重視に戻したいときは環境変数 GEN_MODEL / GEN_MODEL_SINGLE で Sonnet/Opus に切替可能。
const BULK_MODEL = process.env.GEN_MODEL || "claude-haiku-4-5";
const SINGLE_MODEL = process.env.GEN_MODEL_SINGLE || "claude-haiku-4-5";
// 並列数を制限しながら map（順次表示で1食ずつ生成する際、同時実行制限に当たりにくくする）
async function mapLimit(items, limit, fn) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i], i);
    }
  });
  await Promise.all(runners);
}
const SLOT_ORDER = { 朝食: 0, 昼食: 1, 夕食: 2 };
// 「今回はこの方向で」という弱いヒント。食事ごとに1つ回して似た献立への収束を防ぐ。
// 「卵・豆腐など」は入れない（夕食の主菜が軽くなりやすいため、別途ルールで抑えている）。
const STYLE_ROTATION = ["和食", "洋食", "中華・エスニック", "麺類・丼もの", "魚介中心", "焼き物・炒め物", "煮物・煮込み"];
// 使えない主食を指すヒントは外す（「麺なし」なのに「麺類・丼もの」を勧めない）
function styleRotationFor(staple) {
  const on = normalizeStaple(staple);
  if (!on.length || on.includes("noodle")) return STYLE_ROTATION;
  return STYLE_ROTATION.filter((s) => s !== "麺類・丼もの");
}
// 主材料（タンパク質）のローテーション。並列生成でも主材料が連続しないよう、各食事に1つ割り当てて
// から生成する（同じ献立内で「豚肉→豚肉」等が続くのを防ぐ最重要ロジック）。bad=その主材料が
// 避けたい食材に含まれるときは候補から外す用のキーワード。
const MAIN_ROTATION = [
  { label: "鶏肉", bad: ["鶏", "とり", "チキン"] },
  { label: "豚肉", bad: ["豚", "ポーク"] },
  { label: "魚介（魚・えび・いか等）", bad: ["魚", "さかな", "えび", "エビ", "いか", "イカ", "魚介", "シーフード", "貝"] },
  { label: "牛肉またはひき肉", bad: ["牛", "ビーフ"] },
  // 卵・豆腐だけだと夕食の主菜としては物足りないので、肉やひき肉と
  // 組み合わせた「食べごたえのある一皿」になるようラベルで方向づけている。
  { label: "豆腐・厚揚げ・卵（肉やひき肉と合わせて食べごたえを出す）", bad: ["卵", "たまご", "豆腐", "大豆", "納豆"] },
  { label: "野菜中心（肉・魚を主役にしない）", bad: [] },
];
function effectiveMainRotation(avoidText) {
  const a = avoidText || "";
  const eff = MAIN_ROTATION.filter((m) => !m.bad.some((k) => a.includes(k)));
  return eff.length >= 2 ? eff : MAIN_ROTATION; // 絞りすぎたら通常に戻す（避けたい食材はプロンプトで担保）
}
const MAIN_LABELS = MAIN_ROTATION.map((m) => m.label);
// 副菜のカテゴリ（同じ献立内でサラダばかり…等の被りを防ぐためにローテーションする）
const SIDE_LABELS = [
  "葉物のおひたし・和え物",
  "生野菜のサラダ",
  "根菜・かぼちゃの煮物",
  "野菜炒め・ソテー",
  "ナムル・中華和え",
  "酢の物・マリネ",
  "豆腐・卵の小鉢",
  "きのこの副菜",
];
// 固定ローテーションのフォールバック（プランナー失敗時）。初日の日付で開始位置をずらす。
// 6種を等間隔で回すと「豆腐・厚揚げ・卵」と「野菜中心」だけで1/3を占めてしまい、
// 夕食が軽い日ばかりになる。肉・魚介を厚めにした順番で回す。
const FALLBACK_MAIN_ORDER = [0, 2, 1, 3, 0, 2, 4, 1, 3, 5]; // MAIN_ROTATION の添字
function fallbackMainHints(units, avoidText) {
  const rot = effectiveMainRotation(avoidText);
  const order = rot.length === MAIN_ROTATION.length
    ? FALLBACK_MAIN_ORDER
    : rot.map((_, i) => i); // 避けたい食材で絞られたときは単純に一巡させる
  const off = Number((units[0]?.date || "").slice(8, 10)) || 0;
  return units.map((_, i) => rot[order[(i + off) % order.length]].label);
}
function fallbackSideHints(units) {
  const off = Number((units[0]?.date || "").slice(8, 10)) || 0;
  return units.map((_, i) => SIDE_LABELS[(i + off) % SIDE_LABELS.length]);
}
// 隣り合う同じ値を解消する（プランナー出力の保険）。まず局所的な入れ替えを試し、
// それで直らなければ「各値の回数を保ったまま」全体を並べ直す（＝配分は必ず維持）。
function breakConsecutive(arr) {
  const hasAdj = (x) => x.some((v, i) => i > 0 && v === x[i - 1]);
  if (!hasAdj(arr)) return arr;
  const a = arr.slice();
  for (let i = 1; i < a.length; i++) {
    if (a[i] !== a[i - 1]) continue;
    for (let k = 0; k < a.length; k++) {
      if (a[k] === a[i]) continue;
      const okAtI = a[k] !== a[i - 1] && (i + 1 >= a.length || a[k] !== a[i + 1]);
      const okAtK = (k - 1 < 0 || a[i] !== a[k - 1]) && (k + 1 >= a.length || a[i] !== a[k + 1]);
      if (okAtI && okAtK) { [a[i], a[k]] = [a[k], a[i]]; break; }
    }
  }
  if (!hasAdj(a)) return a;
  // 入れ替えで直らない場合: 回数の多い順に1つ飛ばしで配置（偶数位置→奇数位置）
  const count = new Map();
  for (const v of arr) count.set(v, (count.get(v) || 0) + 1);
  const out = new Array(arr.length);
  let idx = 0;
  for (const [v, c] of [...count.entries()].sort((x, y) => y[1] - x[1])) {
    for (let j = 0; j < c; j++) {
      out[idx] = v;
      idx += 2;
      if (idx >= arr.length) idx = 1;
    }
  }
  return out;
}

// 同じ日の中で主材料が重ならないようにする（昼が魚なら夕は魚以外）。
// breakConsecutive は「並びの隣」しか見ないので、朝・昼・夕で 鶏/豚/鶏 のような
// 飛び石の重複が残る。ここも回数は変えず、並べ替えだけで直す。
function breakSameDayDuplicates(units, arr) {
  const a = arr.slice();
  const sameDay = (i, j) => units[i] && units[j] && units[i].date === units[j].date;
  const dupInDay = (x, i) => x.some((v, j) => j !== i && sameDay(i, j) && v === x[i]);
  const adjDup = (x, i) => (i > 0 && x[i] === x[i - 1]) || (i + 1 < x.length && x[i] === x[i + 1]);
  const bad = (x, i) => dupInDay(x, i) || adjDup(x, i);
  for (let i = 0; i < a.length; i++) {
    if (!dupInDay(a, i)) continue;
    for (let k = 0; k < a.length; k++) {
      if (a[k] === a[i]) continue;
      [a[i], a[k]] = [a[k], a[i]];
      if (!bad(a, i) && !bad(a, k)) break; // 両方おさまったら採用
      [a[i], a[k]] = [a[k], a[i]]; // だめなら戻す
    }
  }
  return a;
}

async function generate(targets, opts, diversity = {}, model = BULK_MODEL) {
  const stream = client.messages.stream({
    model,
    max_tokens: 32000,
    tools: [
      {
        name: "save_meal_plan",
        description: "作成した献立プランを保存する。",
        input_schema: MEAL_PLAN_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: "save_meal_plan" },
    messages: [{ role: "user", content: buildPrompt(targets, opts, diversity) }],
  });
  const message = await stream.finalMessage();
  const toolBlock = message.content.find(
    (b) => b.type === "tool_use" && b.name === "save_meal_plan"
  );
  if (!toolBlock) throw new Error("EMPTY_RESPONSE");
  return normalizePlanMainTypes(toolBlock.input); // { days: [...] }（main_type を4種に正規化）
}

// 割り当て表を先に作る（プランナー）。各食事に「主菜の主材料」と「副菜のカテゴリ」を割り当て、
// 要望の配分（例:「肉5日魚2日」）を反映しつつ、主菜・副菜とも被り/連続を防ぐ。
// 並列生成の前に1回だけ呼ぶ。失敗時は固定ローテ。
const MEAL_ASSIGN_SCHEMA = {
  type: "object",
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          main: { type: "string", enum: MAIN_LABELS, description: "主菜の主材料" },
          side: { type: "string", enum: SIDE_LABELS, description: "副菜のカテゴリ" },
          fridgeDish: { type: "string", description: "冷蔵庫の残り食材を複数まとめて使い切る定番料理名（該当する食事のみ。無ければ空文字）" },
        },
        required: ["main", "side"],
        additionalProperties: false,
      },
      description: "各食事の割り当て。meals と同じ順・同じ個数で返す。",
    },
  },
  required: ["assignments"],
  additionalProperties: false,
};
// 「肉多め/魚多め/半々」を具体的な食数に変換する（曖昧な「多め」だと反映が弱いため）
function guidedMainsLine(mains, n) {
  // 「多め」であって「全部」ではない。2食だけのときに全部同じ主材料になると、
  // 同じ日に魚が2回…のようになるので、必ず1食は別の主材料を残す。
  const more = Math.min(Math.max(Math.ceil(n * 0.6), Math.min(n, 2)), Math.max(1, n - 1));
  if (mains === "肉多め") return `主菜のバランス指定: 肉多め → ${n}食中${more}食以上を肉系（鶏肉/豚肉/牛肉/ひき肉）にする。残りは魚介や卵・豆腐も混ぜる。`;
  if (mains === "魚多め") return `主菜のバランス指定: 魚多め → ${n}食中${more}食以上を「魚介（魚・えび・いか等）」にする。残りは肉なども混ぜる。`;
  if (mains === "肉と魚を半々") { const half = Math.floor(n / 2); return `主菜のバランス指定: 肉と魚を半々 → ${n}食中、肉系${half}食・魚介${n - half}食程度にする。`; }
  return "";
}

async function planMealAssignments(units, opts, avoidText) {
  const allowed = effectiveMainRotation(avoidText).map((m) => m.label);
  const list = units.map((u, i) => `${i + 1}. ${u.date} ${u.slot}`).join("\n");
  const prompt = [
    `次の${units.length}食に、各食事の「主菜の主材料(main)」と「副菜のカテゴリ(side)」を割り当ててください。`,
    "食事一覧（この順・この数ちょうどで assignments を返す）:",
    list,
    "",
    `ユーザーの要望: ${opts.preferences ? `「${opts.preferences}」` : "特になし"}`,
    opts.guided?.mains ? guidedMainsLine(opts.guided.mains, units.length) : "",
    avoidText ? `避けたい食材（この主材料は使わない）: ${avoidText}` : "",
    opts.fridgeUse && opts.fridgeUse.length
      ? [
          `冷蔵庫に残っている食材（使い切りたい）: ${opts.fridgeUse.map((f) => f.name + (f.amount ? `(${f.amount})` : "")).join("、")}`,
          "→ まず食材の「組み合わせ」を見て、一般家庭の定番料理が自然に見えるなら、どこか1食の fridgeDish にその料理名を入れて複数の食材を一皿でまとめて使い切る。",
          "  例) 鶏肉+豆腐+白菜+ねぎ →「鶏と豆腐の水炊き」/ 豚肉+キャベツ →「回鍋肉」/ 牛肉+じゃがいも+玉ねぎ →「肉じゃが」/ ひき肉+なす →「麻婆なす」。",
          "→ fridgeDish を入れた食事の main はその料理と整合させる（鍋なら鶏肉、麻婆なすならひき肉）。",
          "→ 自然な組み合わせが無ければ fridgeDish は空にして、主材料の割り当てで食材が活きるようにするだけでよい（例: ひき肉があれば「ひき肉」の日を作る）。不自然な融合料理（例: 豆腐のオムレツ）は絶対に作らない。",
          "→ いずれも要望の配分との両立を優先。",
        ].join("\n")
      : "",
    "",
    "主菜(main)のルール（重要）:",
    "- 要望に主材料の配分・希望（例:「肉を5日・魚を2日」「魚多め」「野菜中心の日を作る」など）があれば、それを最優先で正確に反映する（日数・比率を必ず守る）。",
    "- 要望に配分の指定が無ければ、栄養バランスよく散らす。",
    "- いずれの場合も、同じ主材料が2日以上連続しないようにする（要望と両立できる範囲で）。",
    "- 同じ日に2食以上作るときは、その日の中でも主材料を重ならせない（昼が魚介なら夕は魚介以外にする）。副菜のカテゴリも同様。",
    // 卵・豆腐と野菜中心は軽くなりやすく、夕食で続くと物足りない献立になる
    "- 「豆腐・厚揚げ・卵」と「野菜中心」は軽い主菜になりやすいので、夕食では合わせて全体の1〜2割程度（7食なら1食、多くて2食）にとどめ、肉・魚介を中心に配分する。朝食・昼食ではこの制限はない。",
    `- main は必ず次のいずれか: ${allowed.join(" / ")}`,
    "",
    "副菜(side)のルール（重要）:",
    "- カテゴリに変化をつけ、同じカテゴリを連続させない・全体でも偏らせない（サラダばかり等にしない）。",
    "- 主菜と食材が被るカテゴリは避ける（例: 主菜が卵・豆腐系の日は「豆腐・卵の小鉢」を選ばない）。",
    "- 要望に副菜の指定（例:「サラダ多め」）があれば反映する。",
    `- side は必ず次のいずれか: ${SIDE_LABELS.join(" / ")}`,
    "",
    "- assignments は食事とちょうど同じ数・同じ順で返す。",
  ].filter(Boolean).join("\n");
  try {
    const stream = client.messages.stream({
      model: SINGLE_MODEL,
      max_tokens: 1500,
      tools: [{ name: "assign_meals", description: "各食事の主菜の主材料と副菜のカテゴリを割り当てる。", input_schema: MEAL_ASSIGN_SCHEMA }],
      tool_choice: { type: "tool", name: "assign_meals" },
      messages: [{ role: "user", content: prompt }],
    });
    const msg = await stream.finalMessage();
    const tb = msg.content.find((b) => b.type === "tool_use" && b.name === "assign_meals");
    const arr = tb?.input?.assignments;
    if (
      Array.isArray(arr) && arr.length === units.length &&
      arr.every((x) => x && MAIN_LABELS.includes(x.main) && SIDE_LABELS.includes(x.side))
    ) {
      return {
        // AIがルールを守り損ねても、連続と「同じ日の重複」はコードで排除する
        mains: breakSameDayDuplicates(units, breakConsecutive(arr.map((x) => x.main))),
        sides: breakSameDayDuplicates(units, breakConsecutive(arr.map((x) => x.side))),
        fridgeDishes: arr.map((x) => (x.fridgeDish || "").toString().trim().slice(0, 30)), // 使い切りの一皿（該当食のみ）
      };
    }
  } catch (e) {
    console.error("献立プランナー失敗:", (e && e.message) || e);
  }
  return { mains: fallbackMainHints(units, avoidText), sides: fallbackSideHints(units), fridgeDishes: units.map(() => "") }; // 失敗時は固定ローテーション
}

// main_type の表記ゆれ（「鶏肉」「魚介」等）を 肉/魚/卵・豆腐/野菜 の4種に正規化する。
// モデルは enum を強制されないため、保存前にサーバー側で必ず整える。
const MAIN_TYPE_SET = ["肉", "魚", "卵・豆腐", "野菜"];
function normalizeDishMainType(dish) {
  if (!dish) return dish;
  if (dish.role !== "主菜") { delete dish.main_type; return dish; }
  if (MAIN_TYPE_SET.includes(dish.main_type)) return dish;
  const txt = [dish.main_type || "", dish.name || "", ...(dish.ingredients || []).map((i) => i.name || "")].join(" ");
  if (/魚|鮭|さば|鯖|ぶり|ブリ|たら|タラ|あじ|アジ|いわし|さんま|かれい|かじき|まぐろ|かつお|えび|海老|エビ|いか|イカ|たこ|貝|ホタテ|あさり|しらす|ツナ|刺身/.test(txt)) dish.main_type = "魚";
  else if (/肉|ハム|ベーコン|ウインナー|ソーセージ|チキン|ポーク|ビーフ|ひき/.test(txt)) dish.main_type = "肉";
  else if (/卵|たまご|豆腐|厚揚げ|油揚げ|納豆|大豆/.test(txt)) dish.main_type = "卵・豆腐";
  else dish.main_type = "野菜";
  return dish;
}
function normalizePlanMainTypes(plan) {
  for (const d of plan?.days || [])
    for (const m of d.meals || [])
      for (const dish of m.dishes || []) attachChoice(normalizeDishMainType(dish));
  return plan;
}

// 「作り方は生成しない」モード用。生成後にサーバー側で作り方(steps)を確実に削除する。
// （モデルはプロンプト無視で steps を返すことがあるため、ここで削るのが唯一確実な方法）
function stripSteps(plan) {
  for (const d of plan?.days || [])
    for (const m of d.meals || [])
      for (const dish of m.dishes || []) delete dish.steps;
  return plan;
}

// ---------- 1品だけ差し替え生成（機能5） ----------
const SINGLE_DISH_SCHEMA = {
  type: "object",
  properties: { dish: DISH },
  required: ["dish"],
  additionalProperties: false,
};

function buildDishPrompt(instruction, ctx) {
  const { people, maxCookMinutes, preferences, avoid, current, others } = ctx;
  const ingLine = (d) =>
    (d.ingredients || []).map((i) => `${i.name}${i.amount ? `(${i.amount})` : ""}`).join("、");
  return [
    "あなたは共働き家庭向けの時短献立プランナーです。1食の中の「1品」を、ユーザーの指示に沿って作り直してください。",
    "",
    "【今の料理（これを置き換える。※参考情報。指示が「別の料理」ならこの内容に引きずられないこと）】",
    current
      ? `役割: ${current.role || "料理"} / 名前: ${current.name || "（未設定）"}` +
        (current.description ? ` / 説明: ${current.description}` : "") +
        (ingLine(current) ? `\n材料: ${ingLine(current)}` : "")
      : "（新規）",
    "",
    others && others.length
      ? `【同じ食事の他の品（重複を避け、栄養バランスの参考に）】\n${others
          .map((d) => `- ${d.role || "料理"}: ${d.name}`)
          .join("\n")}`
      : "",
    "",
    `【ユーザーの指示（最優先で反映）】\n${instruction}`,
    "",
    `人数: ${people}人分（材料の分量は人数に合わせる）`,
    maxCookMinutes
      ? `調理時間の目安は ${maxCookMinutes} 分以内にし、cook_minutes に数値を入れる。`
      : "cook_minutes に調理時間の目安（分）の数値を入れる。",
    preferences ? `世帯の好み・要望: ${preferences}` : "",
    avoid ? `避けたい食材・アレルギー: ${avoid}（絶対に使用しない）` : "",
    "",
    "ルール:",
    "- ユーザーの指示を最優先で反映する。指示になければ、今の料理の役割（主菜/副菜/汁物）を保つ。",
    "- 指示の種類によって作り方を変える（重要）:",
    "  A) 味付け・辛さ・時短・子ども向け等の「調整」の指示（例:「もっと辛く」「15分で作れるように」）→ 今の料理をベースに手直しする。",
    "  B) 「別の料理」への変更の指示（例:「グラタンにして」「魚料理に変えて」「中華にして」）→ 今の料理の名前・食材には引きずられず、その料理として一般家庭で定番の姿をゼロから設計する。元の料理の食材をそのまま流用しない。",
    "     例) 「豚とナスの味噌炒め」に「グラタンにして」→ ○ 定番のマカロニグラタンやえびグラタン ／ × 豚とナスのグラタン（元の食材の使い回し）。",
    "     ※指示の中で食材の指定があるとき（例:「ナスを使ってグラタンに」）だけ、その食材に従う。",
    "- 一般家庭でよく作る定番の料理にする（奇をてらわない）。料理名は短くシンプルな一般名にし、カッコ書きの外国語名や『〜風』『〜ソース』等の装飾は付けない。",
    "- role は「主菜」「副菜」「汁物」のいずれか。主菜なら main_type（肉 / 魚 / 卵・豆腐 / 野菜）も入れる。",
    "- 主菜を卵・豆腐・厚揚げで作るときは、それだけで完結させず、肉・ひき肉・魚介などを組み合わせて食べごたえのある一皿にする（○ 麻婆豆腐・肉豆腐・豆腐ハンバーグ・厚揚げと豚肉の味噌炒め ／ × プレーンオムレツだけ・冷奴だけ）。ユーザーが軽い卵料理を指定した場合はその指示を優先する。",
    "- 魚は種類を変えても成立する料理（塩焼き・ムニエル・フライ・煮付け・刺身等）なら魚種を特定しない一般名にし、材料も「魚の切り身」等にする（さばの味噌煮・ぶり大根のように魚種と一体の定番はそのままでよい）。サラダは定番野菜で作る。",
    "- 材料は name（食材名）・amount（分量）・category（分類）に分ける。category は 野菜・果物 / 肉・魚 / 卵・乳・豆腐 / 主食・乾物 / 調味料 / その他 から選び、常備調味料と水・お湯は必ず「調味料」にする。",
    "- 分量表記: 野菜・果物・豆腐など数えられる食材は「1/2個(100g)」のように個数(目安の重量g)で書く（単位は個・本・枚・袋・束・株・丁・かけ等、数は整数かきれいな分数。gだけの表記は野菜に使わない）。肉・魚は「200g」「2切れ(160g)」など重量基本、調味料は大さじ・小さじ・少々。",
    "- にんにく・しょうがは必ず「かけ」で書く（「片」「小さじ」は使わない）。食材名はひらがな・カタカナ・漢字を混ぜず、○ にんにく／にんじん／しょうが／玉ねぎ／じゃがいも／ねぎ　× ニンニク／人参／生姜／タマネギ に揃える。",
    "- 手順は簡潔な箇条書き。すべて日本語。",
    "- 料理は1品だけ、save_dish ツールで返す。",
  ]
    .filter(Boolean)
    .join("\n");
}

async function generateDish(instruction, ctx) {
  const stream = client.messages.stream({
    model: SINGLE_MODEL, // 1品差し替えは単発操作＝速い Haiku
    max_tokens: 8000,
    tools: [
      {
        name: "save_dish",
        description: "作り直した1品の料理を保存する。",
        input_schema: SINGLE_DISH_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: "save_dish" },
    messages: [{ role: "user", content: buildDishPrompt(instruction, ctx) }],
  });
  const message = await stream.finalMessage();
  const toolBlock = message.content.find(
    (b) => b.type === "tool_use" && b.name === "save_dish"
  );
  if (!toolBlock || !toolBlock.input?.dish) throw new Error("EMPTY_RESPONSE");
  return attachChoice(normalizeDishMainType(toolBlock.input.dish));
}

// こだわり（誘導式チップ）の値を許可リストで検証する
const GUIDED_ALLOW = {
  mains: ["肉多め", "魚多め", "肉と魚を半々"],
  cooking: ["揚げ物なし", "レンジ・時短中心"],
  // カタログの属性をそのまま選べるようにしたもの（候補の絞り込みにも使う）
  style: ["子どもも食べやすい", "辛いものなし", "作り置きしたい", "洗い物少なめ", "節約したい"],
};
const GUIDED_MULTI = ["cooking", "style"]; // 複数選択できる項目（揚げ物なし＋時短 の併用など）
function sanitizeGuided(v) {
  const out = {};
  if (v && typeof v === "object") {
    for (const k of Object.keys(GUIDED_ALLOW)) {
      if (GUIDED_MULTI.includes(k)) {
        const arr = Array.isArray(v[k]) ? v[k] : v[k] ? [v[k]] : []; // 旧形式(単一文字列)も受ける
        const picked = [...new Set(arr.filter((x) => GUIDED_ALLOW[k].includes(x)))];
        if (picked.length) out[k] = picked;
      } else if (GUIDED_ALLOW[k].includes(v[k])) {
        out[k] = v[k];
      }
    }
  }
  return out;
}

// 冷蔵庫の使い切り指定を安全な形に整える（最大20件・名前30字・量20字）
function sanitizeFridgeUse(v) {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, 20)
    .map((x) => ({
      name: (x?.name || "").toString().trim().slice(0, 30),
      amount: (x?.amount || "").toString().trim().slice(0, 20),
    }))
    .filter((x) => x.name);
}

// ---------- 入力バリデーション ----------
function validateTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) return "対象の日を1つ以上選んでください。";
  if (targets.length > MAX_DAYS) return `対象日が多すぎます（最大${MAX_DAYS}日）。`;
  let slotCount = 0;
  for (const t of targets) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date || "")) return "日付の形式が正しくありません。";
    if (!Array.isArray(t.slots) || t.slots.length === 0) return "各日に食事を1つ以上選んでください。";
    slotCount += t.slots.length;
  }
  if (slotCount > MAX_SLOTS) return `生成する食事が多すぎます（最大${MAX_SLOTS}食）。範囲を狭めてください。`;
  return null;
}

// 直近（既定21日）に作った「主菜」の料理名を集めて、メインのマンネリ回避に使う。
// 副菜（味噌汁・サラダ等）は自然な繰り返しを許容するため対象にしない。
async function getRecentDishNames(householdId, { days = 21, planLimit = 12, cap = 30 } = {}) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await all(
    "SELECT data_json FROM meal_plans WHERE household_id = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT $3",
    [householdId, cutoff, planLimit]
  );
  const names = [];
  for (const r of rows) {
    try {
      for (const day of JSON.parse(r.data_json).days || [])
        for (const meal of day.meals || [])
          for (const dish of meal.dishes || [])
            if (dish.name && dish.role === "主菜") names.push(dish.name);
    } catch {}
  }
  return [...new Set(names)].slice(0, cap);
}

// 同じ食事枠（朝食/昼食/夕食）ごとに、直近（既定30日）に出した料理名を集める。
// 主菜・副菜の繰り返し防止に使う（例: 夕食の副菜「キャベツとコーンのサラダ」が何度も出るのを防ぐ）。
// 汁物は毎日の味噌汁など自然な繰り返しが普通のため対象にしない。日付の新しい順。
async function getRecentDishesBySlot(householdId, { days = 30, planLimit = 15, capPerSlot = 36 } = {}) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await all(
    "SELECT data_json FROM meal_plans WHERE household_id = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT $3",
    [householdId, cutoff, planLimit]
  );
  const entries = []; // { slot, name, date }
  for (const r of rows) {
    try {
      for (const day of JSON.parse(r.data_json).days || [])
        for (const meal of day.meals || [])
          for (const dish of meal.dishes || [])
            if (dish.name && dish.role !== "汁物")
              entries.push({ slot: meal.slot, name: dish.name, date: day.date || "" });
    } catch {}
  }
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // 新しい日付順
  const bySlot = {};
  for (const e of entries) {
    const arr = (bySlot[e.slot] ||= []);
    if (arr.length < capPerSlot && !arr.includes(e.name)) arr.push(e.name);
  }
  return bySlot;
}

// 世帯の食材設定を { avoid:[絶対NG], soft:[控えめ] } で返す
async function getStoreItems(householdId) {
  const rows = await all(
    "SELECT name, kind FROM store_items WHERE household_id = $1 ORDER BY created_at",
    [householdId]
  );
  const pick = (k) => rows.filter((r) => r.kind === k).map((r) => r.name);
  return {
    avoid: pick("avoid"),
    soft: [...pick("soft"), ...pick("hard")], // hard は旧仕様（控えめ扱い）
  };
}

function handleError(res, err) {
  console.error(err);
  const msg = err?.message || "";
  const status = err?.status || 500;
  if (status === 401 || /authentication method|api[_ ]?key/i.test(msg)) {
    return res.status(500).json({
      error: "APIキーが未設定または無効です。ANTHROPIC_API_KEY を設定してから起動してください。",
    });
  }
  if (msg === "EMPTY_RESPONSE") {
    return res.status(502).json({ error: "生成に失敗しました（応答が空でした）。" });
  }
  res.status(500).json({ error: "処理中にエラーが発生しました。" });
}

// ---------- 認証 API ----------
const userToClient = (u) => ({ id: u.id, username: u.username, displayName: u.display_name || u.username });
// 通知やメンバー表示に使う「表示名」。未設定なら username にフォールバック。
const displayNameOf = (u) => (u && (u.display_name || u.username)) || "";

// Googleユーザー用に一意な username（ログインID）を自動生成する。
// 招待は username で行うため、Googleユーザーにも handle を用意しておく。
async function generateUniqueUsername(seed) {
  let base = (seed || "user").toString().toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 14);
  if (base.length < 2) base = "user";
  for (let i = 0; i < 20; i++) {
    const cand = i === 0 ? base : `${base}${randomBytes(3).toString("hex")}`;
    if (!(await one("SELECT 1 FROM users WHERE username_lc = $1", [cand.toLowerCase()]))) return cand;
  }
  return `user${randomUUID().slice(0, 8)}`;
}
async function householdsOf(userId) {
  return await all(
    `SELECT h.id, h.name FROM households h JOIN memberships m ON m.household_id = h.id
     WHERE m.user_id = $1 ORDER BY m.created_at`,
    [userId]
  );
}

app.post("/api/auth/register", authLimiter, async (req, res) => {
  try {
    const username = (req.body?.username || "").toString().trim();
    const password = (req.body?.password || "").toString();
    if (username.length < 2 || username.length > 20)
      return res.status(400).json({ error: "ユーザー名は2〜20文字にしてください。" });
    if (password.length < 6)
      return res.status(400).json({ error: "パスワードは6文字以上にしてください。" });
    const lc = username.toLowerCase();
    if (await one("SELECT 1 FROM users WHERE username_lc = $1", [lc]))
      return res.status(409).json({ error: "そのユーザー名は既に使われています。" });
    const id = randomUUID();
    await q(
      "INSERT INTO users (id, username, username_lc, pw_hash, created_at) VALUES ($1, $2, $3, $4, $5)",
      [id, username, lc, hashPassword(password), new Date().toISOString()]
    );
    res.json({ token: await createSession(id), user: { id, username, displayName: username } });
  } catch (err) {
    handleError(res, err);
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const username = (req.body?.username || "").toString().trim();
    const password = (req.body?.password || "").toString();
    const u = await one("SELECT * FROM users WHERE username_lc = $1", [username.toLowerCase()]);
    if (!u || !u.pw_hash || !verifyPassword(password, u.pw_hash))
      return res.status(401).json({ error: "ユーザー名またはパスワードが違います。" });
    res.json({ token: await createSession(u.id), user: userToClient(u) });
  } catch (err) {
    handleError(res, err);
  }
});

// クライアントに渡す認証設定（Googleログインの有効可否とクライアントID＝非秘密）
// 食材名の別名表（正規化キー→食品番号）。画面側で「玉ねぎ」と「たまねぎ」を
// 同じ食材として扱うために配る。あわせて、買い物リストで単位を揃えるのに使う
// 1個・大さじ1のグラム数も返す。内容は起動中変わらないのでキャッシュ可。
let FOOD_ALIAS_CACHE = null;
app.get("/api/food-aliases", (req, res) => {
  if (!FOOD_ALIAS_CACHE) FOOD_ALIAS_CACHE = { aliases: foodAliasMap(), ...foodUnitTables() };
  res.set("Cache-Control", "public, max-age=86400");
  res.json(FOOD_ALIAS_CACHE);
});

// コラム（content/columns/*.md）。起動時に一度読んで配る。
// .md を直して再デプロイすれば反映される（書き出しのコマンドは不要）。
let COLUMNS_CACHE = null;
app.get("/api/columns", (req, res) => {
  if (!COLUMNS_CACHE) {
    const r = readColumns();
    if (r.problems?.length) console.log("（コラムの注意: " + r.problems.join(" / ") + "）");
    COLUMNS_CACHE = { columns: r.columns, byFood: r.byFood, byAdvice: r.byAdvice };
  }
  res.set("Cache-Control", "public, max-age=300"); // 5分。デプロイ後すぐ新しい記事が出る
  res.json(COLUMNS_CACHE);
});

app.get("/api/auth/config", (req, res) => {
  res.json({ googleEnabled: googleEnabled(), googleClientId: googleEnabled() ? GOOGLE_CLIENT_ID : null });
});

// Googleログイン: クライアントの IDトークン(credential) を検証し、既存Googleユーザーはログイン、
// 未登録なら新規作成。現行の username/password ユーザーとは別アカウント（メール連携は将来）。
app.post("/api/auth/google", authLimiter, async (req, res) => {
  try {
    if (!googleEnabled()) return res.status(400).json({ error: "Googleログインは利用できません。" });
    const credential = (req.body?.credential || "").toString();
    if (!credential) return res.status(400).json({ error: "認証情報がありません。" });

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch {
      return res.status(401).json({ error: "Google認証に失敗しました。もう一度お試しください。" });
    }
    if (!payload || !payload.sub) return res.status(401).json({ error: "Google認証に失敗しました。" });

    const sub = payload.sub;
    const email = payload.email || null;
    const gname = (payload.name || payload.given_name || "").toString().slice(0, 20) || null;

    let u = await one("SELECT * FROM users WHERE google_sub = $1", [sub]);
    if (!u) {
      const id = randomUUID();
      const seed = email ? email.split("@")[0] : "user";
      const username = await generateUniqueUsername(seed);
      await q(
        `INSERT INTO users (id, username, username_lc, pw_hash, display_name, google_sub, email, created_at)
         VALUES ($1, $2, $3, NULL, $4, $5, $6, $7)`,
        [id, username, username.toLowerCase(), gname, sub, email, new Date().toISOString()]
      );
      u = await one("SELECT * FROM users WHERE id = $1", [id]);
    } else if (email && u.email !== email) {
      await q("UPDATE users SET email = $1 WHERE id = $2", [email, u.id]); // メール更新に追随
      u.email = email;
    }
    res.json({ token: await createSession(u.id), user: userToClient(u) });
  } catch (err) {
    handleError(res, err);
  }
});

app.post("/api/auth/logout", auth, async (req, res) => {
  try {
    const token = (req.headers.authorization || "").slice(7);
    await q("DELETE FROM sessions WHERE token = $1", [token]);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

app.get("/api/auth/me", auth, async (req, res) => {
  try {
    res.json({ user: userToClient(req.user), households: await householdsOf(req.user.id) });
  } catch (err) {
    handleError(res, err);
  }
});

// 表示名の変更（ログイン用 username は変えない）。空にすると username に戻る。
app.post("/api/auth/profile", auth, async (req, res) => {
  try {
    const dn = (req.body?.displayName ?? "").toString().trim();
    if (dn.length > 20) return res.status(400).json({ error: "表示名は20文字以内にしてください。" });
    await q("UPDATE users SET display_name = $1 WHERE id = $2", [dn || null, req.user.id]);
    res.json({ displayName: dn || req.user.username });
  } catch (err) {
    handleError(res, err);
  }
});

// ---------- 世帯 API（認証必須） ----------
app.post("/api/households", auth, async (req, res) => {
  try {
    const name = (req.body?.name || `${displayNameOf(req.user)}のグループ`).toString().slice(0, 40);
    const id = randomUUID();
    const now = new Date().toISOString();
    await q("INSERT INTO households (id, name, share_token, created_at) VALUES ($1, $2, $3, $4)", [
      id, name, randomBytes(12).toString("base64url"), now,
    ]);
    await q("INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ($1, $2, $3, $4)", [
      id, req.user.id, "owner", now,
    ]);
    res.json({ id, name });
  } catch (err) {
    handleError(res, err);
  }
});

app.get("/api/households", auth, async (req, res) => {
  try {
    res.json(await householdsOf(req.user.id));
  } catch (err) {
    handleError(res, err);
  }
});

// グループ名の変更（メンバーなら可）
app.post("/api/households/:id/rename", auth, async (req, res) => {
  try {
    const hh = await requireMember(req, res, req.params.id);
    if (!hh) return;
    const name = (req.body?.name ?? "").toString().trim();
    if (!name) return res.status(400).json({ error: "グループ名を入力してください。" });
    const trimmed = name.slice(0, 40);
    await q("UPDATE households SET name = $1 WHERE id = $2", [trimmed, hh.id]);
    res.json({ id: hh.id, name: trimmed });
  } catch (err) {
    handleError(res, err);
  }
});

app.get("/api/households/:id/members", auth, async (req, res) => {
  try {
    if (!(await requireMember(req, res, req.params.id))) return;
    const rows = await all(
      `SELECT u.username, u.display_name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.household_id = $1 ORDER BY m.created_at`,
      [req.params.id]
    );
    res.json(rows.map((m) => ({ username: m.username, displayName: m.display_name || m.username, role: m.role })));
  } catch (err) {
    handleError(res, err);
  }
});

// 共同編集者をユーザー名で招待
app.post("/api/households/:id/members", auth, async (req, res) => {
  try {
    if (!(await requireMember(req, res, req.params.id))) return;
    const uname = (req.body?.username || "").toString().trim();
    const target = await one("SELECT * FROM users WHERE username_lc = $1", [uname.toLowerCase()]);
    if (!target) return res.status(404).json({ error: "そのユーザーは見つかりません。" });
    if (await isMember(target.id, req.params.id)) return res.status(409).json({ error: "すでにメンバーです。" });
    await q("INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ($1, $2, $3, $4)", [
      req.params.id, target.id, "member", new Date().toISOString(),
    ]);
    res.json({ ok: true, username: target.username });
  } catch (err) {
    handleError(res, err);
  }
});

// 招待リンク（共有トークン付きURL）を取得。メンバーのみ。
app.get("/api/households/:id/share", auth, async (req, res) => {
  try {
    const hh = await requireMember(req, res, req.params.id);
    if (!hh) return;
    res.json({ token: hh.share_token, url: `${appBaseUrl(req)}/?join=${hh.share_token}` });
  } catch (err) {
    handleError(res, err);
  }
});

// 招待リンクを再発行（古いリンクを無効化したいとき）。メンバーのみ。
app.post("/api/households/:id/share/rotate", auth, async (req, res) => {
  try {
    const hh = await requireMember(req, res, req.params.id);
    if (!hh) return;
    const token = randomBytes(12).toString("base64url");
    await q("UPDATE households SET share_token = $1 WHERE id = $2", [token, hh.id]);
    res.json({ token, url: `${appBaseUrl(req)}/?join=${token}` });
  } catch (err) {
    handleError(res, err);
  }
});

// ---------- 常備品リスト（世帯ごと・共有） ----------
app.get("/api/households/:id/pantry", auth, async (req, res) => {
  try {
    if (!(await requireMember(req, res, req.params.id))) return;
    const rows = await all(
      "SELECT id, name FROM pantry_items WHERE household_id = $1 ORDER BY created_at",
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    handleError(res, err);
  }
});

app.post("/api/households/:id/pantry", auth, async (req, res) => {
  try {
    if (!(await requireMember(req, res, req.params.id))) return;
    const name = (req.body?.name || "").toString().trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: "食材名を入力してください。" });
    const norm = normName(name);
    const existing = await one(
      "SELECT id, name FROM pantry_items WHERE household_id = $1 AND name_norm = $2",
      [req.params.id, norm]
    );
    if (existing) return res.json(existing); // 重複は既存を返す（冪等）
    const id = randomUUID();
    await q(
      "INSERT INTO pantry_items (id, household_id, name, name_norm, created_at) VALUES ($1, $2, $3, $4, $5)",
      [id, req.params.id, name, norm, new Date().toISOString()]
    );
    res.json({ id, name });
  } catch (err) {
    handleError(res, err);
  }
});

app.delete("/api/households/:id/pantry/:itemId", auth, async (req, res) => {
  try {
    if (!(await requireMember(req, res, req.params.id))) return;
    await q("DELETE FROM pantry_items WHERE id = $1 AND household_id = $2", [
      req.params.itemId, req.params.id,
    ]);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

// ---------- 要望テンプレ（世帯ごと・共有） ----------
app.get("/api/households/:id/presets", auth, async (req, res) => {
  try {
    if (!(await requireMember(req, res, req.params.id))) return;
    const rows = await all(
      "SELECT id, text FROM preference_presets WHERE household_id = $1 ORDER BY created_at",
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    handleError(res, err);
  }
});

app.post("/api/households/:id/presets", auth, async (req, res) => {
  try {
    if (!(await requireMember(req, res, req.params.id))) return;
    const text = (req.body?.text || "").toString().trim().slice(0, 80);
    if (!text) return res.status(400).json({ error: "テンプレの内容を入力してください。" });
    const count = await one("SELECT count(*)::int AS n FROM preference_presets WHERE household_id = $1", [req.params.id]);
    if (count && count.n >= 20) return res.status(400).json({ error: "テンプレは20件までです。不要なものを削除してください。" });
    // 同一テキストの重複は既存を返す（冪等）
    const existing = await one(
      "SELECT id, text FROM preference_presets WHERE household_id = $1 AND lower(text) = lower($2)",
      [req.params.id, text]
    );
    if (existing) return res.json(existing);
    const id = randomUUID();
    await q(
      "INSERT INTO preference_presets (id, household_id, text, created_at) VALUES ($1, $2, $3, $4)",
      [id, req.params.id, text, new Date().toISOString()]
    );
    res.json({ id, text });
  } catch (err) {
    handleError(res, err);
  }
});

app.delete("/api/households/:id/presets/:presetId", auth, async (req, res) => {
  try {
    if (!(await requireMember(req, res, req.params.id))) return;
    await q("DELETE FROM preference_presets WHERE id = $1 AND household_id = $2", [
      req.params.presetId, req.params.id,
    ]);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

// ---------- お気に入りレシピ（世帯ごと・共有） ----------
const favToClient = (r) => {
  let dish = null;
  if (r.dish_json) { try { dish = JSON.parse(r.dish_json); } catch {} }
  return { id: r.id, name: r.name, role: r.role || dish?.role || "", dish };
};

app.get("/api/households/:id/favorites", auth, async (req, res) => {
  try {
    if (!(await requireMember(req, res, req.params.id))) return;
    const rows = await all(
      "SELECT * FROM favorite_dishes WHERE household_id = $1 ORDER BY created_at DESC",
      [req.params.id]
    );
    res.json(rows.map(favToClient));
  } catch (err) {
    handleError(res, err);
  }
});

// 追加（同名は上書き＝スナップショットの更新。名前だけの登録は dish なしでOK）
app.post("/api/households/:id/favorites", auth, async (req, res) => {
  try {
    if (!(await requireMember(req, res, req.params.id))) return;
    const name = (req.body?.name || "").toString().trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: "料理名を入力してください。" });
    const role = (req.body?.role || "").toString().trim().slice(0, 10) || null;
    let dishJson = null;
    if (req.body?.dish && typeof req.body.dish === "object") {
      dishJson = JSON.stringify(req.body.dish);
      if (dishJson.length > 20000) return res.status(413).json({ error: "レシピが大きすぎます。" });
    }
    const norm = normName(name);
    const existing = await one(
      "SELECT * FROM favorite_dishes WHERE household_id = $1 AND name_norm = $2",
      [req.params.id, norm]
    );
    if (existing) {
      const updated = await one(
        "UPDATE favorite_dishes SET name = $1, role = COALESCE($2, role), dish_json = COALESCE($3, dish_json) WHERE id = $4 RETURNING *",
        [name, role, dishJson, existing.id]
      );
      return res.json(favToClient(updated));
    }
    const count = await one("SELECT count(*)::int AS n FROM favorite_dishes WHERE household_id = $1", [req.params.id]);
    if (count && count.n >= 100) return res.status(400).json({ error: "お気に入りは100件までです。不要なものを削除してください。" });
    const id = randomUUID();
    const row = await one(
      `INSERT INTO favorite_dishes (id, household_id, name, name_norm, role, dish_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, req.params.id, name, norm, role, dishJson, new Date().toISOString()]
    );
    res.json(favToClient(row));
  } catch (err) {
    handleError(res, err);
  }
});

app.delete("/api/households/:id/favorites/:favId", auth, async (req, res) => {
  try {
    if (!(await requireMember(req, res, req.params.id))) return;
    await q("DELETE FROM favorite_dishes WHERE id = $1 AND household_id = $2", [
      req.params.favId, req.params.id,
    ]);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

// ---------- 冷蔵庫・作り置き（世帯ごと・共有） ----------
app.get("/api/households/:id/fridge", auth, async (req, res) => {
  try {
    if (!(await requireMember(req, res, req.params.id))) return;
    const rows = await all(
      "SELECT id, name, kind, amount, created_at FROM fridge_items WHERE household_id = $1 ORDER BY created_at DESC",
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    handleError(res, err);
  }
});

// 追加（同名×同種は上書き＝量と登録日を更新。作り置きの「作り直した」にも対応）
app.post("/api/households/:id/fridge", auth, async (req, res) => {
  try {
    if (!(await requireMember(req, res, req.params.id))) return;
    const name = (req.body?.name || "").toString().trim().slice(0, 30);
    if (!name) return res.status(400).json({ error: "名前を入力してください。" });
    const kind = ["ingredient", "prepped"].includes(req.body?.kind) ? req.body.kind : "ingredient";
    const amount = (req.body?.amount || "").toString().trim().slice(0, 20) || null;
    const norm = normName(name);
    const now = new Date().toISOString();
    const existing = await one(
      "SELECT * FROM fridge_items WHERE household_id = $1 AND kind = $2 AND name_norm = $3",
      [req.params.id, kind, norm]
    );
    if (existing) {
      const updated = await one(
        "UPDATE fridge_items SET name = $1, amount = $2, created_at = $3 WHERE id = $4 RETURNING id, name, kind, amount, created_at",
        [name, amount, now, existing.id]
      );
      return res.json(updated);
    }
    const count = await one("SELECT count(*)::int AS n FROM fridge_items WHERE household_id = $1", [req.params.id]);
    if (count && count.n >= 60) return res.status(400).json({ error: "登録は60件までです。使い切ったものを削除してください。" });
    const row = await one(
      `INSERT INTO fridge_items (id, household_id, name, name_norm, kind, amount, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, kind, amount, created_at`,
      [randomUUID(), req.params.id, name, norm, kind, amount, now]
    );
    res.json(row);
  } catch (err) {
    handleError(res, err);
  }
});

app.delete("/api/households/:id/fridge/:itemId", auth, async (req, res) => {
  try {
    if (!(await requireMember(req, res, req.params.id))) return;
    await q("DELETE FROM fridge_items WHERE id = $1 AND household_id = $2", [
      req.params.itemId, req.params.id,
    ]);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

// 食材の設定（使わない／控えめにする）
app.get("/api/households/:id/store-items", auth, async (req, res) => {
  try {
    if (!(await requireMember(req, res, req.params.id))) return;
    const rows = await all(
      "SELECT id, name, kind FROM store_items WHERE household_id = $1 ORDER BY created_at",
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    handleError(res, err);
  }
});

app.post("/api/households/:id/store-items", auth, async (req, res) => {
  try {
    if (!(await requireMember(req, res, req.params.id))) return;
    const name = (req.body?.name || "").toString().trim().slice(0, 40);
    const kind = ["avoid", "soft"].includes(req.body?.kind) ? req.body.kind : null;
    if (!name) return res.status(400).json({ error: "食材名を入力してください。" });
    if (!kind) return res.status(400).json({ error: "種類が正しくありません。" });
    const norm = normName(name);
    const existing = await one(
      "SELECT id, name, kind FROM store_items WHERE household_id = $1 AND kind = $2 AND name_norm = $3",
      [req.params.id, kind, norm]
    );
    if (existing) return res.json(existing); // 重複は既存を返す（冪等）
    const id = randomUUID();
    await q(
      "INSERT INTO store_items (id, household_id, name, name_norm, kind, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, req.params.id, name, norm, kind, new Date().toISOString()]
    );
    res.json({ id, name, kind });
  } catch (err) {
    handleError(res, err);
  }
});

app.delete("/api/households/:id/store-items/:itemId", auth, async (req, res) => {
  try {
    if (!(await requireMember(req, res, req.params.id))) return;
    await q("DELETE FROM store_items WHERE id = $1 AND household_id = $2", [
      req.params.itemId, req.params.id,
    ]);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

// 旧・共有トークンの世帯を自分のアカウントに取り込む（移行用）
app.post("/api/households/claim", auth, async (req, res) => {
  try {
    const token = (req.body?.shareToken || "").toString().trim();
    const hh = await one("SELECT * FROM households WHERE share_token = $1", [token]);
    if (!hh) return res.status(404).json({ error: "グループが見つかりません。" });
    if (!(await isMember(req.user.id, hh.id))) {
      await q("INSERT INTO memberships (household_id, user_id, role, created_at) VALUES ($1, $2, $3, $4)", [
        hh.id, req.user.id, "member", new Date().toISOString(),
      ]);
    }
    res.json({ id: hh.id, name: hh.name });
  } catch (err) {
    handleError(res, err);
  }
});

// ---------- プッシュ通知（Web Push / PWA） ----------
// ユーザーの通知設定を取得（無ければ既定=全ON を作成）。
async function getNotifPrefs(userId) {
  let p = await one("SELECT * FROM notification_prefs WHERE user_id = $1", [userId]);
  if (!p) {
    await q(
      "INSERT INTO notification_prefs (user_id, updated_at) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING",
      [userId, new Date().toISOString()]
    );
    p = await one("SELECT * FROM notification_prefs WHERE user_id = $1", [userId]);
  }
  return p || { dinner_reminder: true, plan_reminder: true, member_update: true };
}

// 1ユーザーの全端末へ送信（kind の設定がOFFなら送らない）。無効な購読は掃除する。
async function pushToUser(userId, kind, payload) {
  if (!pushEnabled()) return 0;
  const pref = await getNotifPrefs(userId);
  if (kind && pref[kind] === false) return 0;
  const subs = await all("SELECT * FROM push_subscriptions WHERE user_id = $1", [userId]);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload)
      );
      sent++;
    } catch (e) {
      // 端末が購読解除/失効（404/410）なら購読を削除
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        await q("DELETE FROM push_subscriptions WHERE endpoint = $1", [s.endpoint]).catch(() => {});
      } else {
        console.error("push送信エラー:", (e && e.message) || e);
      }
    }
  }
  return sent;
}

// 世帯の「本人以外」のメンバーへ送信。
async function pushToHouseholdOthers(householdId, excludeUserId, kind, payload) {
  const members = await all("SELECT user_id FROM memberships WHERE household_id = $1", [householdId]);
  for (const m of members) {
    if (m.user_id === excludeUserId) continue;
    await pushToUser(m.user_id, kind, payload);
  }
}

// 献立の作成を世帯の他メンバーへ通知（fire-and-forget で呼ぶ）
async function notifyPlanCreated(householdId, actor, row) {
  const md = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : "");
  const range = row.start_date === row.end_date ? md(row.start_date) : `${md(row.start_date)}〜${md(row.end_date)}`;
  await pushToHouseholdOthers(householdId, actor.id, "member_update", {
    title: "めにゅらく！",
    body: `${displayNameOf(actor)}さんが献立（${range}）を作りました`,
    url: "/",
    tag: "plan-" + row.id,
  });
}

app.get("/api/push/config", (req, res) => {
  res.json({ enabled: pushEnabled(), publicKey: pushEnabled() ? VAPID_PUBLIC_KEY : null });
});

app.post("/api/push/subscribe", auth, async (req, res) => {
  try {
    const sub = req.body?.subscription;
    if (!sub || !sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth)
      return res.status(400).json({ error: "購読情報が正しくありません。" });
    await q(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = $2, p256dh = $4, auth = $5`,
      [randomUUID(), req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date().toISOString()]
    );
    await getNotifPrefs(req.user.id); // 既定設定を用意
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

app.post("/api/push/unsubscribe", auth, async (req, res) => {
  try {
    const endpoint = req.body?.endpoint;
    if (endpoint) await q("DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2", [endpoint, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

app.get("/api/push/prefs", auth, async (req, res) => {
  try {
    const p = await getNotifPrefs(req.user.id);
    res.json({
      dinner_reminder: p.dinner_reminder !== false,
      plan_reminder: p.plan_reminder !== false,
      member_update: p.member_update !== false,
    });
  } catch (err) {
    handleError(res, err);
  }
});

app.post("/api/push/prefs", auth, async (req, res) => {
  try {
    const b = req.body || {};
    const cur = await getNotifPrefs(req.user.id);
    const val = (k) => (typeof b[k] === "boolean" ? b[k] : cur[k] !== false);
    await q(
      `UPDATE notification_prefs SET dinner_reminder = $2, plan_reminder = $3, member_update = $4, updated_at = $5
       WHERE user_id = $1`,
      [req.user.id, val("dinner_reminder"), val("plan_reminder"), val("member_update"), new Date().toISOString()]
    );
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

// テスト通知（設定画面の「テスト送信」用。kind無し＝設定に関わらず必ず届く）
app.post("/api/push/test", auth, async (req, res) => {
  try {
    const n = await pushToUser(req.user.id, null, {
      title: "めにゅらく！",
      body: "通知のテストです。これが届けば設定完了です🎉",
      url: "/",
    });
    res.json({ ok: true, sent: n });
  } catch (err) {
    handleError(res, err);
  }
});

// ---------- プラン API（認証＋メンバー必須） ----------
function planToClient(row) {
  return {
    id: row.id,
    householdId: row.household_id,
    startDate: row.start_date,
    endDate: row.end_date,
    people: row.people,
    maxCookMinutes: row.max_cook_minutes,
    dishCount: row.dish_count,
    preferences: row.preferences,
    avoid: row.avoid,
    createdAt: row.created_at,
    days: JSON.parse(row.data_json).days,
  };
}
async function loadPlanForUser(req, res) {
  const row = await one("SELECT * FROM meal_plans WHERE id = $1", [req.params.id]);
  if (!row) { res.status(404).json({ error: "プランが見つかりません。" }); return null; }
  if (!(await isMember(req.user.id, row.household_id))) { res.status(403).json({ error: "アクセス権がありません。" }); return null; }
  return row;
}

const INSERT_PLAN = `INSERT INTO meal_plans
  (id, household_id, start_date, end_date, people, max_cook_minutes, dish_count,
   preferences, avoid, input_json, data_json, created_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`;

// 「上書き」用: 対象の (日付|食事) と重なる既存の食事を、他のプランから取り除く。
// 空になった日は削除し、日が全部無くなったプランは削除する。exceptId=今作った新プランは対象外。
async function removeOverlappingMeals(householdId, exceptId, targets) {
  const want = new Set();
  for (const t of targets || []) for (const slot of t.slots || []) want.add(`${t.date}|${slot}`);
  if (want.size === 0) return;
  const rows = await all("SELECT id, data_json FROM meal_plans WHERE household_id = $1 AND id <> $2", [householdId, exceptId]);
  for (const row of rows) {
    let data;
    try { data = JSON.parse(row.data_json); } catch { continue; }
    let changed = false;
    for (const day of data.days || []) {
      const before = (day.meals || []).length;
      day.meals = (day.meals || []).filter((m) => !want.has(`${day.date}|${m.slot}`));
      if (day.meals.length !== before) changed = true;
    }
    if (!changed) continue;
    data.days = (data.days || []).filter((d) => (d.meals || []).length > 0);
    if (data.days.length === 0) {
      await q("DELETE FROM meal_plans WHERE id = $1", [row.id]);
    } else {
      const dates = data.days.map((d) => d.date).sort();
      await q("UPDATE meal_plans SET data_json = $1, start_date = $2, end_date = $3 WHERE id = $4",
        [JSON.stringify(data), dates[0], dates[dates.length - 1], row.id]);
    }
  }
}

app.post("/api/plans", auth, aiLimiter, requireAi((req) => aiCostFromTargets(req.body?.targets)), async (req, res) => {
  try {
    const { householdId, targets, people, maxCookMinutes, dishCount, staple, preferences, avoid, includeSteps } =
      req.body || {};
    const household = await requireMember(req, res, householdId);
    if (!household) return;

    const vErr = validateTargets(targets);
    if (vErr) return res.status(400).json({ error: vErr });

    const opts = {
      people: Number(people) > 0 ? Number(people) : 2,
      maxCookMinutes: Number(maxCookMinutes) > 0 ? Number(maxCookMinutes) : null,
      dishCount: dishCount || "main_side",
      staple: normalizeStaple(staple),
      fridgeUse: sanitizeFridgeUse(req.body?.fridgeUse), // 冷蔵庫の使い切り指定（[{name, amount}]）
      guided: sanitizeGuided(req.body?.guided), // こだわりチップ（主菜バランス/ジャンル/調理法）
      preferences: (preferences || "").toString().trim(),
      avoid: (avoid || "").toString().trim(),
      includeSteps: includeSteps !== false, // false で「作り方は生成しない（献立だけ）」
    };

    const recentDishes = await getRecentDishNames(household.id);
    const store = await getStoreItems(household.id);
    const plan = await generate(targets, opts, { recentDishes, storeAvoid: store.avoid, storeSoft: store.soft });
    if (!opts.includeSteps) stripSteps(plan); // モデルが返しても作り方を確実に除去

    const dates = targets.map((t) => t.date).sort();
    const row = await one(INSERT_PLAN, [
      randomUUID(),
      household.id,
      dates[0],
      dates[dates.length - 1],
      opts.people,
      opts.maxCookMinutes,
      opts.dishCount,
      opts.preferences,
      opts.avoid,
      JSON.stringify({ targets, opts }),
      JSON.stringify(plan),
      new Date().toISOString(),
    ]);
    if (!req.aiPaid) await incAiUsage(req.user.id, req.aiCost || 1, req.aiKind); // 無料は成功時のみ食数分を消費
    if (req.body?.overwrite) await removeOverlappingMeals(household.id, row.id, targets); // 上書き=重複する既存の食事を除去
    notifyPlanCreated(household.id, req.user, row).catch(() => {}); // 世帯の他メンバーへ通知
    res.json(planToClient(row));
  } catch (err) {
    handleError(res, err);
  }
});

// 献立を1食ずつAIで作り、まとまったら保存する。
// 画面からの生成（順次表示）と、毎週の自動作成の両方がここを通る。
// send は途中経過の通知先。自動作成では何もしない関数を渡す。
async function generateAndSavePlan(household, opts, targets, send = () => {}) {
    const recentDishes = await getRecentDishNames(household.id);
    const recentBySlot = await getRecentDishesBySlot(household.id); // 食事枠ごとの履歴（副菜含む・30日）
    const store = await getStoreItems(household.id);

    const units = [];
    for (const t of targets) for (const slot of t.slots) units.push({ date: t.date, slot });
    send({ type: "start", total: units.length, units: units.map((u) => ({ date: u.date, slot: u.slot })) });

    // 主材料＋副菜カテゴリの割り当てを先に決める（要望の配分を反映＋被り/連続回避）。
    // 2食以上のときだけプランナーを使う。
    const avoidText = [opts.avoid, ...(store.avoid || [])].filter(Boolean).join("、");
    const needSides = String(opts.dishCount || "").includes("side");
    const assign = units.length >= 2
      ? await planMealAssignments(units, opts, avoidText)
      : { mains: units.map(() => ""), sides: units.map(() => ""), fridgeDishes: units.map(() => "") };

    const styles = styleRotationFor(opts.staple);
    // 候補出しで避ける料理名（最近作ったもの＋この画面で既に確定したもの）
    const recentAll = [...new Set([...recentDishes, ...Object.values(recentBySlot).flat()])];
    const mainCandidatesFor = (u, o, st, extraAvoid, mainHint) => {
      const r = pickMainCandidates({
        slot: u.slot,
        date: u.date,
        maxMinutes: o.maxCookMinutes,
        staples: o.staple,
        avoidText: [o.avoid, ...(st.avoid || [])].filter(Boolean).join("、"),
        noFry: (o.guided?.cooking || []).includes("揚げ物なし"),
        quick: (o.guided?.cooking || []).includes("レンジ・時短中心"),
        style: o.guided?.style || [],
        mainHint,
        excludeNames: [...recentAll, ...(extraAvoid || [])],
      });
      return r.dishes.map(candidateLine);
    };
    const collected = new Map();
    const batchMains = new Set(); // このバッチで確定した主菜名（並列でも同名に収束しないよう照合する）
    const mainNameOf = (ds) => ((ds || []).find((d) => d.role === "主菜") || (ds || [])[0] || {}).name || "";
    // 同じ日の他の食事に何を割り当てたか（並列生成でも先に決まっているので順序に依存しない）
    const sameDayOf = (i) => units
      .map((v, k) => (k !== i && v.date === units[i].date ? `${v.slot}: ${assign.mains[k] || "おまかせ"}` : null))
      .filter(Boolean);
    await mapLimit(units, 4, async (u, i) => {
      let dishes = [];
      const fridgeDishHint = (assign.fridgeDishes || [])[i] || ""; // 使い切りの一皿（例: 鶏と豆腐の水炊き）
      const mainHint = fridgeDishHint ? "" : (assign.mains[i] || ""); // 料理指定がある食事は主材料指定より優先
      const sideHint = needSides ? assign.sides[i] || "" : ""; // 副菜のカテゴリ（同上）
      const div = (attempt, avoid) => ({
        recentDishes, recentSlotDishes: recentBySlot[u.slot] || [], mainHint, sideHint, fridgeDishHint,
        avoidDishes: avoid || [],
        styleHint: styles[(i + attempt) % styles.length],
        storeAvoid: store.avoid, storeSoft: store.soft,
        // 冷蔵庫の使い切りで料理が決まっている食事は、候補を出さない（そちらが最優先のため）
        mainCandidates: fridgeDishHint ? [] : mainCandidatesFor(u, opts, store, [...batchMains, ...(avoid || [])], mainHint),
        sameDayDishes: sameDayOf(i),
      });
      // Haiku はまれに dishes 空を返すため、空なら作り直す（最大3回）
      try {
        for (let attempt = 0; attempt < 3 && dishes.length === 0; attempt++) {
          const r = await generate([{ date: u.date, slots: [u.slot] }], opts, div(attempt), SINGLE_MODEL);
          dishes = r.days?.[0]?.meals?.[0]?.dishes || [];
        }
        // 主菜名がバッチ内で重複したら、その名前を避けて作り直す（最大2回。並列生成の盲点をコードで補正）
        for (let retry = 0; retry < 2 && mainNameOf(dishes) && batchMains.has(mainNameOf(dishes)); retry++) {
          const r2 = await generate([{ date: u.date, slots: [u.slot] }], opts, div(retry + 1, [...batchMains]), SINGLE_MODEL);
          const nd = r2.days?.[0]?.meals?.[0]?.dishes || [];
          if (nd.length) dishes = nd;
        }
      } catch (e) {
        if (!dishes.length) dishes = [];
      }
      const mn = mainNameOf(dishes);
      if (mn) batchMains.add(mn);
      if (!opts.includeSteps) dishes.forEach((d) => delete d.steps);
      collected.set(`${u.date}|${u.slot}`, dishes);
      send(
        dishes.length
          ? { type: "meal", date: u.date, slot: u.slot, dishes }
          : { type: "meal_error", date: u.date, slot: u.slot }
      );
    });

    // 全食まとまったらプランを組み立てて保存
    const byDate = new Map(targets.map((t) => [t.date, []]));
    for (const t of targets)
      for (const slot of t.slots)
        byDate.get(t.date).push({ slot, dishes: collected.get(`${t.date}|${slot}`) || [] });
    const days = [...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([date, meals]) => ({
        date,
        meals: meals.sort((a, b) => (SLOT_ORDER[a.slot] ?? 9) - (SLOT_ORDER[b.slot] ?? 9)),
      }));
    const dates = targets.map((t) => t.date).sort();
    return await one(INSERT_PLAN, [
      randomUUID(), household.id, dates[0], dates[dates.length - 1], opts.people, opts.maxCookMinutes,
      opts.dishCount, opts.preferences, opts.avoid,
      JSON.stringify({ targets, opts }), JSON.stringify({ days }), new Date().toISOString(),
    ]);
}

// 順次表示（progressive）: 食事ごとに生成し、完成したものから ndjson で流す。
// 単発生成＝速い Haiku を使い、最初の1食を早く画面に出す。最後に組み立てて保存し done を返す。
app.post("/api/plans/stream", auth, aiLimiter, requireAi((req) => aiCostFromTargets(req.body?.targets)), async (req, res) => {
  const send = (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch {} };
  try {
    const { householdId, targets, people, maxCookMinutes, dishCount, staple, preferences, avoid, includeSteps } =
      req.body || {};
    const household = await requireMember(req, res, householdId);
    if (!household) return;
    const vErr = validateTargets(targets);
    if (vErr) return res.status(400).json({ error: vErr });

    const opts = {
      people: Number(people) > 0 ? Number(people) : 2,
      maxCookMinutes: Number(maxCookMinutes) > 0 ? Number(maxCookMinutes) : null,
      dishCount: dishCount || "main_side",
      staple: normalizeStaple(staple),
      fridgeUse: sanitizeFridgeUse(req.body?.fridgeUse), // 冷蔵庫の使い切り指定（[{name, amount}]）
      guided: sanitizeGuided(req.body?.guided), // こだわりチップ（主菜バランス/調理法/好み）
      preferences: (preferences || "").toString().trim(),
      avoid: (avoid || "").toString().trim(),
      includeSteps: includeSteps !== false,
    };
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no"); // プロキシのバッファリング無効化

    const row = await generateAndSavePlan(household, opts, targets, send);
    if (!req.aiPaid) await incAiUsage(req.user.id, req.aiCost || 1, req.aiKind);
    if (req.body?.overwrite) await removeOverlappingMeals(household.id, row.id, targets); // 上書き=重複する既存の食事を除去
    notifyPlanCreated(household.id, req.user, row).catch(() => {}); // 世帯の他メンバーへ通知
    send({ type: "done", plan: planToClient(row) });
    res.end();
  } catch (err) {
    if (res.headersSent) { send({ type: "fatal", error: (err && err.message) || "生成に失敗しました" }); res.end(); }
    else handleError(res, err);
  }
});

// ---------- 毎週おまかせ作成（プレミアム） ----------
// 曜日・時刻はすべて日本時間。サーバのタイムゾーンには依存させない。
const AUTO_SLOTS = ["朝食", "昼食", "夕食"];
const clampInt = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
};
// 曜日ごとの食事。{"0":["夕食"], ...} の形だけ通す。
function sanitizeDowSlots(v) {
  const out = {};
  if (v && typeof v === "object") {
    for (let d = 0; d <= 6; d++) {
      const arr = (Array.isArray(v[d]) ? v[d] : Array.isArray(v[String(d)]) ? v[String(d)] : [])
        .filter((s) => AUTO_SLOTS.includes(s));
      const uniq = AUTO_SLOTS.filter((s) => arr.includes(s));
      if (uniq.length) out[d] = uniq;
    }
  }
  return out;
}
// 旧形式（全曜日で同じ slots ＋ 平日のみ）から曜日ごとの形に直す
function dowSlotsOf(r) {
  try {
    const j = JSON.parse(r.dow_slots || "null");
    if (j && Object.keys(j).length) return sanitizeDowSlots(j);
  } catch {}
  const slots = String(r.slots || "夕食").split(",").filter(Boolean);
  const out = {};
  for (let d = 0; d <= 6; d++) {
    if (r.weekdays_only && (d === 0 || d === 6)) continue;
    out[d] = slots;
  }
  return out;
}
function autoToClient(r, householdId) {
  if (!r) {
    const dowSlots = {};
    for (let d = 1; d <= 5; d++) dowSlots[d] = ["夕食"]; // 既定は平日の夕食
    return { enabled: false, weekday: 0, hour: 18, days: 7, dowSlots, opts: {}, householdId };
  }
  let opts = {};
  try { opts = JSON.parse(r.opts_json || "{}"); } catch {}
  return {
    householdId, enabled: !!r.enabled, weekday: r.weekday, hour: r.hour, days: r.days,
    dowSlots: dowSlotsOf(r), opts, lastRun: r.last_run || null, lastStatus: r.last_status || null,
  };
}
app.get("/api/households/:id/auto", auth, async (req, res) => {
  try {
    const household = await requireMember(req, res, req.params.id);
    if (!household) return;
    const r = await one("SELECT * FROM auto_plans WHERE household_id = $1", [household.id]);
    res.json({ ...autoToClient(r, household.id), premium: await hasAi(req.user.id) });
  } catch (err) { handleError(res, err); }
});
app.post("/api/households/:id/auto", auth, async (req, res) => {
  try {
    const household = await requireMember(req, res, req.params.id);
    if (!household) return;
    const b = req.body || {};
    const dowSlots = sanitizeDowSlots(b.dowSlots);
    const opts = {
      people: clampInt(b.opts?.people, 1, 12, 2),
      maxCookMinutes: b.opts?.maxCookMinutes ? clampInt(b.opts.maxCookMinutes, 5, 180, 30) : null,
      dishCount: DISH_COUNT_DIRECTIVE[b.opts?.dishCount] ? b.opts.dishCount : "main_side",
      staple: normalizeStaple(b.opts?.staple),
      preferences: (b.opts?.preferences || "").toString().trim().slice(0, 300),
      guided: sanitizeGuided(b.opts?.guided),
    };
    const now = new Date().toISOString();
    await q(
      `INSERT INTO auto_plans (household_id, user_id, enabled, weekday, hour, days, slots, dow_slots, opts_json, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (household_id) DO UPDATE SET
         user_id = $2, enabled = $3, weekday = $4, hour = $5, days = $6, slots = $7,
         dow_slots = $8, opts_json = $9, updated_at = $10`,
      [household.id, req.user.id, !!b.enabled, clampInt(b.weekday, 0, 6, 0), clampInt(b.hour, 0, 23, 18),
       clampInt(b.days, 1, 14, 7), "夕食", JSON.stringify(dowSlots),
       JSON.stringify(opts), now]
    );
    const r = await one("SELECT * FROM auto_plans WHERE household_id = $1", [household.id]);
    res.json({ ...autoToClient(r, household.id), premium: await hasAi(req.user.id) });
  } catch (err) { handleError(res, err); }
});

// AIを使わず空の献立を作る（手打ち入力用・APIキー不要）
// 作り方なしの即時生成。カタログに材料が入っているので、AIを呼ばずに献立を組める。
// 待ち時間ゼロ・無料枠も減らない（requireAi を通さない）。自由入力の要望は反映されない。
app.post("/api/plans/quick", auth, async (req, res) => {
  try {
    const { householdId, targets, people, maxCookMinutes, dishCount, staple, avoid } = req.body || {};
    const household = await requireMember(req, res, householdId);
    if (!household) return;
    const vErr = validateTargets(targets);
    if (vErr) return res.status(400).json({ error: vErr });

    const store = await getStoreItems(household.id);
    const opts = {
      people: Number(people) > 0 ? Math.min(12, Number(people)) : 2,
      maxCookMinutes: Number(maxCookMinutes) > 0 ? Number(maxCookMinutes) : null,
      dishCount: dishCount || "main_side",
      staple: normalizeStaple(staple),
      guided: sanitizeGuided(req.body?.guided),
      avoid: (avoid || "").toString().trim(),
      storeAvoid: store.avoid,
      includeSteps: false, // カタログに作り方は入っていない
    };
    const units = [];
    for (const t of targets) for (const slot of t.slots) units.push({ date: t.date, slot });
    const plan = buildPlanFromCatalog(units, { ...opts, recentNames: await getRecentDishNames(household.id) });

    const dates = targets.map((t) => t.date).sort();
    const row = await one(INSERT_PLAN, [
      randomUUID(), household.id, dates[0], dates[dates.length - 1], opts.people, opts.maxCookMinutes,
      opts.dishCount, "", opts.avoid,
      JSON.stringify({ targets, opts }), JSON.stringify(plan), new Date().toISOString(),
    ]);
    if (req.body?.overwrite) await removeOverlappingMeals(household.id, row.id, targets);
    notifyPlanCreated(household.id, req.user, row).catch(() => {});
    res.json(planToClient(row));
  } catch (err) {
    handleError(res, err);
  }
});

app.post("/api/plans/manual", auth, async (req, res) => {
  try {
    const { householdId, targets, people, dishCount } = req.body || {};
    const household = await requireMember(req, res, householdId);
    if (!household) return;
    const vErr = validateTargets(targets);
    if (vErr) return res.status(400).json({ error: vErr });

    const p = Number(people) > 0 ? Math.min(12, Number(people)) : 2;
    const days = targets
      .map((t) => ({ date: t.date, meals: t.slots.map((slot) => ({ slot, dishes: [] })) }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const dates = targets.map((t) => t.date).sort();
    const row = await one(INSERT_PLAN, [
      randomUUID(), household.id, dates[0], dates[dates.length - 1], p, null, dishCount || "main_side",
      "", "",
      JSON.stringify({ targets, opts: { people: p, manual: true } }),
      JSON.stringify({ days }),
      new Date().toISOString(),
    ]);
    if (req.body?.overwrite) await removeOverlappingMeals(household.id, row.id, targets); // 上書き=重複する既存の食事を除去
    res.json(planToClient(row));
  } catch (err) {
    handleError(res, err);
  }
});

app.get("/api/plans", auth, async (req, res) => {
  try {
    const household = await requireMember(req, res, req.query.householdId);
    if (!household) return;
    const rows = await all(
      "SELECT * FROM meal_plans WHERE household_id = $1 ORDER BY created_at DESC LIMIT 100",
      [household.id]
    );
    res.json(rows.map(planToClient));
  } catch (err) {
    handleError(res, err);
  }
});

app.get("/api/plans/:id", auth, async (req, res) => {
  try {
    const row = await loadPlanForUser(req, res);
    if (!row) return;
    res.json(planToClient(row));
  } catch (err) {
    handleError(res, err);
  }
});

// 献立の栄養（カロリー・PFC・食物繊維・食塩相当量）を計算して返す。
// 日本食品標準成分表（文部科学省）の値を使い、材料名と分量から1人分を見積もる。
app.get("/api/plans/:id/nutrition", auth, async (req, res) => {
  try {
    const row = await loadPlanForUser(req, res);
    if (!row) return;
    res.json(analyzePlan(JSON.parse(row.data_json), row.people));
  } catch (err) {
    handleError(res, err);
  }
});

// 世帯の栄養を「日付ごと」に計算する。
// 昼と夕を別々に作ると献立が別プランになるので、プラン単位だと1日ぶんが揃わない
// （「昼の分が出てこない」原因）。カレンダーと同じで、日付でまとめてから計算する。
app.get("/api/households/:id/nutrition", auth, async (req, res) => {
  try {
    const household = await requireMember(req, res, req.params.id);
    if (!household) return;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "") ? req.query.to : jstDateStr(jstNow());
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "") ? req.query.from : jstAddDays(to, -6);
    const rows = await all(
      `SELECT people, data_json FROM meal_plans
       WHERE household_id = $1 AND end_date >= $2 AND start_date <= $3 ORDER BY created_at ASC`,
      [household.id, from, to]
    );
    // 同じ日付・同じ食事が複数のプランにあれば、後から作ったほうを採用する
    const byDate = new Map();
    let people = 2;
    for (const r of rows) {
      people = r.people || people;
      let data; try { data = JSON.parse(r.data_json); } catch { continue; }
      for (const d of data.days || []) {
        if (d.date < from || d.date > to) continue;
        if (!byDate.has(d.date)) byDate.set(d.date, new Map());
        const meals = byDate.get(d.date);
        for (const m of d.meals || []) if ((m.dishes || []).length) meals.set(m.slot, m);
      }
    }
    const days = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, meals]) => ({
        date,
        meals: [...meals.values()].sort((a, b) => (SLOT_ORDER[a.slot] ?? 9) - (SLOT_ORDER[b.slot] ?? 9)),
      }));
    const n = analyzePlan({ days }, people);
    // ひとことコメント（プレミアム限定。無料でも「何があるか」は分かるよう鍵付きで返す）
    const premium = await hasAi(req.user.id);
    res.json({ ...n, from, to, premium, advice: premium ? buildAdvice(n) : null });
  } catch (err) {
    handleError(res, err);
  }
});

// 献立の手動編集を保存（days をまるごと差し替え、任意で people 更新）
app.post("/api/plans/:id", auth, async (req, res) => {
  try {
    const row = await loadPlanForUser(req, res);
    if (!row) return;
    const { days, people } = req.body || {};
    if (!Array.isArray(days) || !days.every((d) => d && typeof d.date === "string" && Array.isArray(d.meals))) {
      return res.status(400).json({ error: "データの形式が正しくありません。" });
    }
    if (JSON.stringify(days).length > 400000) {
      return res.status(413).json({ error: "データが大きすぎます。" });
    }
    const p = Number(people) > 0 ? Math.min(12, Number(people)) : row.people;
    // 日付の移動で範囲が変わることがあるので start/end を days から再計算
    const dates = days.map((d) => d.date).filter(Boolean).sort();
    const start = dates[0] || row.start_date;
    const end = dates[dates.length - 1] || row.end_date;
    const updated = await one(
      "UPDATE meal_plans SET data_json = $1, people = $2, start_date = $3, end_date = $4 WHERE id = $5 RETURNING *",
      [JSON.stringify({ days }), p, start, end, row.id]
    );
    res.json(planToClient(updated));
  } catch (err) {
    handleError(res, err);
  }
});

// 献立の削除
app.delete("/api/plans/:id", auth, async (req, res) => {
  try {
    const row = await loadPlanForUser(req, res);
    if (!row) return;
    await q("DELETE FROM meal_plans WHERE id = $1", [row.id]);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

// 1食だけ作り直し
app.post("/api/plans/:id/regenerate", auth, aiLimiter, requireAi(() => 1, "edit"), async (req, res) => {
  try {
    const { date, slot } = req.body || {};
    const row = await loadPlanForUser(req, res);
    if (!row) return;

    const data = JSON.parse(row.data_json);
    const day = data.days.find((d) => d.date === date);
    const meal = day?.meals.find((m) => m.slot === slot);
    if (!meal) return res.status(400).json({ error: "対象の食事が見つかりません。" });

    const { opts } = JSON.parse(row.input_json);
    // このプラン内の全料理名（重複回避）＋ 世帯の直近履歴（マンネリ回避）
    const avoidDishes = [
      ...new Set(data.days.flatMap((d) => d.meals.flatMap((m) => m.dishes.map((x) => x.name)))),
    ];
    const recentDishes = await getRecentDishNames(row.household_id);
    const recentBySlot = await getRecentDishesBySlot(row.household_id); // 同じ食事枠の履歴（副菜含む）
    const store = await getStoreItems(row.household_id);

    // Haiku がまれに空を返すため、非空になるまで最大3回リトライ（AI修正の失敗を減らす）
    let newDishes = null;
    for (let attempt = 0; attempt < 3 && !(newDishes && newDishes.length); attempt++) {
      const regenerated = await generate([{ date, slots: [slot] }], opts, {
        avoidDishes,
        recentDishes,
        recentSlotDishes: recentBySlot[slot] || [],
        storeAvoid: store.avoid,
        storeSoft: store.soft,
        // 作り直しでもカタログから候補を出す（同じ条件で毎回同じ料理に戻らないよう、今の料理も除外）
        mainCandidates: pickMainCandidates({
          slot, date,
          maxMinutes: opts.maxCookMinutes,
          staples: opts.staple,
          avoidText: [opts.avoid, ...(store.avoid || [])].filter(Boolean).join("、"),
          noFry: (opts.guided?.cooking || []).includes("揚げ物なし"),
          quick: (opts.guided?.cooking || []).includes("レンジ・時短中心"),
          style: opts.guided?.style || [],
          excludeNames: [...avoidDishes, ...recentDishes],
        }).dishes.map(candidateLine),
      }, SINGLE_MODEL); // 1食作り直しは単発操作＝速い Haiku
      newDishes = regenerated.days?.[0]?.meals?.[0]?.dishes;
    }
    if (!newDishes || !newDishes.length) throw new Error("EMPTY_RESPONSE");
    if (opts?.includeSteps === false) newDishes.forEach((d) => delete d.steps); // 献立だけモードは作り方を除去

    // 「作り直す前に戻す」用に直前の内容を保持（1世代のみ）
    meal._prevDishes = (meal.dishes || []).map((d) => { const c = { ...d }; delete c._prev; return c; });
    meal.dishes = newDishes;
    const updated = await one(
      "UPDATE meal_plans SET data_json = $1 WHERE id = $2 RETURNING *",
      [JSON.stringify(data), row.id]
    );
    if (!req.aiPaid) await incAiUsage(req.user.id, req.aiCost || 1, req.aiKind);
    res.json(planToClient(updated));
  } catch (err) {
    handleError(res, err);
  }
});

// 料理名・指示を指定して、その1品だけをAIで差し替え（機能5）
app.post("/api/plans/:id/replace-dish", auth, aiLimiter, requireAi(() => 1, "edit"), async (req, res) => {
  try {
    const { date, slot, dishIndex, instruction } = req.body || {};
    const instr = (instruction || "").toString().trim();
    if (!instr) return res.status(400).json({ error: "どんな料理にするか入力してください。" });
    const row = await loadPlanForUser(req, res);
    if (!row) return;

    const data = JSON.parse(row.data_json);
    const day = data.days.find((d) => d.date === date);
    const meal = day?.meals.find((m) => m.slot === slot);
    if (!meal) return res.status(400).json({ error: "対象の食事が見つかりません。" });
    const idx = Number(dishIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= (meal.dishes || []).length) {
      return res.status(400).json({ error: "対象の料理が見つかりません。" });
    }

    const { opts } = JSON.parse(row.input_json);
    const current = meal.dishes[idx];
    const others = meal.dishes.filter((_, i) => i !== idx);
    // Haiku がまれに空を返すため、有効な料理が返るまで最大3回リトライ
    let newDish = null;
    for (let attempt = 0; attempt < 3 && !(newDish && newDish.name); attempt++) {
      newDish = await generateDish(instr, {
        people: row.people,
        maxCookMinutes: opts?.maxCookMinutes,
        preferences: opts?.preferences,
        avoid: opts?.avoid,
        current,
        others,
      });
    }
    if (!newDish || !newDish.name) throw new Error("EMPTY_RESPONSE");

    // 「1つ前に戻す」用に直前の料理を保持（1世代のみ・無限に積まない）
    const prevCopy = { ...current };
    delete prevCopy._prev;
    newDish._prev = prevCopy;
    meal.dishes[idx] = newDish;
    const updated = await one(
      "UPDATE meal_plans SET data_json = $1 WHERE id = $2 RETURNING *",
      [JSON.stringify(data), row.id]
    );
    if (!req.aiPaid) await incAiUsage(req.user.id, req.aiCost || 1, req.aiKind);
    res.json(planToClient(updated));
  } catch (err) {
    handleError(res, err);
  }
});

// ---------- 課金 API（Stripe） ----------
const appBaseUrl = (req) => process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;

// 現在の課金状態＋無料枠の残りをフロントに返す
app.get("/api/billing/status", auth, async (req, res) => {
  try {
    const active = billingEnabled() ? await hasActiveEntitlement(req.user.id) : false;
    const e = await one("SELECT plan, current_period_end FROM entitlements WHERE user_id = $1", [req.user.id]);
    const usage = await getAiUsage(req.user.id);
    res.json({
      billingEnabled: billingEnabled(),
      active,
      plan: active ? e?.plan || "monthly" : null,
      currentPeriodEnd: active ? e?.current_period_end || null : null,
      // 献立生成の無料枠（食数）
      freeLimit: FREE_AI_MEALS_PER_MONTH,
      freeUsed: usage.meals,
      freeRemaining: Math.max(0, FREE_AI_MEALS_PER_MONTH - usage.meals),
      // AI修正の無料枠（回数・別枠）
      editLimit: FREE_AI_EDITS_PER_MONTH,
      editUsed: usage.edits,
      editRemaining: Math.max(0, FREE_AI_EDITS_PER_MONTH - usage.edits),
    });
  } catch (err) {
    handleError(res, err);
  }
});

// 申込（Checkout セッション作成）→ フロントは返ってきた url に遷移
app.post("/api/billing/checkout", auth, async (req, res) => {
  try {
    if (!billingEnabled()) return res.status(503).json({ error: "課金は現在利用できません。" });
    const customerId = await getOrCreateStripeCustomer(req.user);
    const base = appBaseUrl(req);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: req.user.id,
      allow_promotion_codes: true,
      success_url: `${base}/?billing=success`,
      cancel_url: `${base}/?billing=cancel`,
    });
    res.json({ url: session.url });
  } catch (err) {
    handleError(res, err);
  }
});

// 解約・カード変更（Customer Portal）→ フロントは返ってきた url に遷移
app.post("/api/billing/portal", auth, async (req, res) => {
  try {
    if (!billingEnabled()) return res.status(503).json({ error: "課金は現在利用できません。" });
    const e = await one("SELECT stripe_customer_id FROM entitlements WHERE user_id = $1", [req.user.id]);
    if (!e?.stripe_customer_id) return res.status(400).json({ error: "課金情報が見つかりません。" });
    const session = await stripe.billingPortal.sessions.create({
      customer: e.stripe_customer_id,
      return_url: `${appBaseUrl(req)}/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    handleError(res, err);
  }
});

// Stripe Webhook 本体（生ボディで署名検証。ルート登録は express.json より前で実施済み）
async function handleStripeWebhook(req, res) {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook署名検証に失敗:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    await processStripeEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error("Webhook処理エラー:", err.message);
    res.status(500).end(); // 500 を返すと Stripe が再送してくれる
  }
}

async function processStripeEvent(event) {
  const now = new Date().toISOString();
  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    const userId = s.client_reference_id;
    if (!userId) return;
    let periodEnd = null;
    if (s.subscription) {
      const sub = await stripe.subscriptions.retrieve(s.subscription);
      periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
    }
    await q(
      `INSERT INTO entitlements
        (user_id, provider, status, plan, stripe_customer_id, stripe_subscription_id, current_period_end, updated_at)
       VALUES ($1, 'stripe', 'active', 'monthly', $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         status = 'active', plan = 'monthly',
         stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, entitlements.stripe_customer_id),
         stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, entitlements.stripe_subscription_id),
         current_period_end = COALESCE(EXCLUDED.current_period_end, entitlements.current_period_end),
         updated_at = EXCLUDED.updated_at`,
      [userId, s.customer, s.subscription, periodEnd, now]
    );
  } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const isActive = sub.status === "active" || sub.status === "trialing";
    const status = event.type === "customer.subscription.deleted" ? "canceled" : isActive ? "active" : sub.status;
    const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
    await q(
      `UPDATE entitlements SET status = $1, current_period_end = $2, stripe_subscription_id = $3, updated_at = $4
       WHERE stripe_customer_id = $5`,
      [status, periodEnd, sub.id, now, sub.customer]
    );
  }
}

// ---------- 定期通知スケジューラ（今日の夕食 / 週1の献立づくり） ----------
// 日本時間(JST=UTC+9)の「壁掛け時計」を得る（getUTC* で読むとJSTの時分になる）。
function jstNow() {
  return new Date(Date.now() + 9 * 3600 * 1000);
}
// 二重送信防止: 初回だけ true を返す（同 user×kind×日 は1回のみ）。
async function markSentOnce(userId, kind, dayKey) {
  const r = await q(
    "INSERT INTO push_sent_log (user_id, kind, day) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [userId, kind, dayKey]
  );
  return r.rowCount > 0;
}
async function userHasPush(userId) {
  return !!(await one("SELECT 1 FROM push_subscriptions WHERE user_id = $1", [userId]));
}

// 今日の夕食リマインド（夕方に1回）
async function sendDinnerReminders() {
  const today = jstNow().toISOString().slice(0, 10);
  const plans = await all(
    "SELECT household_id, data_json FROM meal_plans WHERE start_date <= $1 AND end_date >= $1 ORDER BY created_at DESC",
    [today]
  );
  const mainByHh = new Map(); // 世帯→今日の夕食の主菜（最新プラン優先）
  for (const p of plans) {
    if (mainByHh.has(p.household_id)) continue;
    let main = null;
    try {
      const day = (JSON.parse(p.data_json).days || []).find((d) => d.date === today);
      const dinner = day && (day.meals || []).find((m) => m.slot === "夕食");
      const dishes = (dinner && dinner.dishes) || [];
      main = (dishes.find((d) => d.role === "主菜") || dishes[0] || {}).name || null;
    } catch {}
    if (main) mainByHh.set(p.household_id, main);
  }
  for (const [hid, main] of mainByHh) {
    const members = await all("SELECT user_id FROM memberships WHERE household_id = $1", [hid]);
    for (const m of members) {
      const pref = await getNotifPrefs(m.user_id);
      if (pref.dinner_reminder === false) continue;
      if (!(await userHasPush(m.user_id))) continue;
      if (!(await markSentOnce(m.user_id, "dinner_reminder", today))) continue;
      await pushToUser(m.user_id, "dinner_reminder", {
        title: "今日の夕食",
        body: `今日は「${main}」です。買い物・下ごしらえはお早めに🍳`,
        url: "/",
        tag: "dinner-" + today,
      });
    }
  }
}

// 週1の献立づくりリマインド（日曜の午前に1回）
async function sendPlanReminders() {
  const now = jstNow();
  if (now.getUTCDay() !== 0) return; // 日曜のみ
  const today = now.toISOString().slice(0, 10);
  const users = await all("SELECT DISTINCT user_id FROM push_subscriptions");
  for (const u of users) {
    const pref = await getNotifPrefs(u.user_id);
    if (pref.plan_reminder === false) continue;
    if (!(await markSentOnce(u.user_id, "plan_reminder", today))) continue;
    await pushToUser(u.user_id, "plan_reminder", {
      title: "今週の献立づくり",
      body: "そろそろ来週の献立を作りませんか？期間を選ぶだけでAIが提案します📝",
      url: "/",
      tag: "planreminder-" + today,
    });
  }
}

// ---------- 毎週おまかせ作成の実行 ----------
// 日付の計算もすべて日本時間で行う。UTCの日付を使うと、日本の 0:00〜9:00 が
// 前日扱いになって「1日ずれる」ので、必ず jstNow() 基準で組み立てる。
const jstDateStr = (d) => d.toISOString().slice(0, 10); // d は jstNow() 由来のものだけ渡す
function jstAddDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const jstDow = (dateStr) => new Date(dateStr + "T00:00:00Z").getUTCDay();

// すでに献立がある「日付|食事」の集合（自動作成では上書きせず、空いている枠だけ作る）
async function existingSlotSet(householdId, from, to) {
  const rows = await all(
    "SELECT data_json FROM meal_plans WHERE household_id = $1 AND end_date >= $2 AND start_date <= $3",
    [householdId, from, to]
  );
  const set = new Set();
  for (const r of rows) {
    try {
      for (const d of JSON.parse(r.data_json).days || [])
        for (const m of d.meals || []) if ((m.dishes || []).length) set.add(`${d.date}|${m.slot}`);
    } catch {}
  }
  return set;
}

async function runAutoPlans() {
  const now = jstNow();
  const today = jstDateStr(now);
  const dow = now.getUTCDay();   // jstNow() は+9時間ずらしてあるので getUTC* が日本時間になる
  const hour = now.getUTCHours();
  const rows = await all("SELECT * FROM auto_plans WHERE enabled = true");
  for (const r of rows) {
    if (r.weekday !== dow || hour < r.hour || r.last_run === today) continue;
    // 先に「今日は実行済み」にしてから作る（失敗しても同じ日に何度も作らない）
    await q("UPDATE auto_plans SET last_run = $1 WHERE household_id = $2", [today, r.household_id]);
    try {
      if (!(await hasAi(r.user_id))) { // 解約後は静かに止める
        await q("UPDATE auto_plans SET last_status = $1 WHERE household_id = $2", ["premium_required", r.household_id]);
        continue;
      }
      const household = await one("SELECT * FROM households WHERE id = $1", [r.household_id]);
      if (!household) continue;
      const dowSlots = dowSlotsOf(r); // 曜日ごとに作る食事
      const from = jstAddDays(today, 1); // 翌日から
      const to = jstAddDays(today, r.days);
      const busy = await existingSlotSet(r.household_id, from, to);
      const targets = [];
      for (let i = 1; i <= r.days; i++) {
        const date = jstAddDays(today, i);
        const want = dowSlots[jstDow(date)] || [];
        const open = want.filter((s) => !busy.has(`${date}|${s}`));
        if (open.length) targets.push({ date, slots: open });
      }
      if (!targets.length) {
        await q("UPDATE auto_plans SET last_status = $1 WHERE household_id = $2", ["already_planned", r.household_id]);
        continue;
      }
      let saved = {};
      try { saved = JSON.parse(r.opts_json || "{}"); } catch {}
      const store = await getStoreItems(r.household_id);
      const opts = {
        people: saved.people || 2,
        maxCookMinutes: saved.maxCookMinutes || null,
        dishCount: saved.dishCount || "main_side",
        staple: normalizeStaple(saved.staple),
        fridgeUse: [], // 自動作成では冷蔵庫の中身は当てにしない（古い情報で献立が歪むため）
        guided: sanitizeGuided(saved.guided),
        preferences: (saved.preferences || "").toString().trim(),
        avoid: (store.avoid || []).join("、"),
        includeSteps: true,
      };
      const row = await generateAndSavePlan(household, opts, targets);
      await q("UPDATE auto_plans SET last_status = $1 WHERE household_id = $2", ["ok", r.household_id]);
      // 世帯のメンバー全員に知らせる
      const n = targets.reduce((a, t) => a + t.slots.length, 0);
      const members = await all("SELECT user_id FROM memberships WHERE household_id = $1", [r.household_id]);
      for (const m of members) {
        if (!(await userHasPush(m.user_id))) continue;
        if (!(await markSentOnce(m.user_id, "auto_plan", today))) continue;
        await pushToUser(m.user_id, "auto_plan", {
          title: "今週の献立ができました",
          body: `${from.slice(5).replace("-", "/")} からの ${n}食分を用意しました。買い物リストもできています🛒`,
          url: "/",
          tag: "autoplan-" + today,
        });
      }
      console.log(`[自動作成] ${household.name || r.household_id}: ${n}食 (${row.id})`);
    } catch (e) {
      await q("UPDATE auto_plans SET last_status = $1 WHERE household_id = $2", ["error", r.household_id]);
      console.error("auto plan error:", (e && e.message) || e);
    }
  }
}

let schedulerBusy = false;
async function schedulerTick() {
  if (schedulerBusy) return;
  schedulerBusy = true;
  try {
    const h = jstNow().getUTCHours();
    if (pushEnabled()) {
      if (h >= 16 && h < 22) await sendDinnerReminders(); // 夕方〜夜
      if (h >= 10 && h < 20) await sendPlanReminders(); // 日曜の日中（関数内で曜日判定）
    }
    await runAutoPlans(); // 通知が未設定でも献立は作る（通知だけ飛ばない）
  } catch (e) {
    console.error("scheduler error:", (e && e.message) || e);
  } finally {
    schedulerBusy = false;
  }
}

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`めにゅらく！ 起動: http://localhost:${PORT}`);
    });
    // 定期通知と、毎週おまかせ作成の判定
    setInterval(schedulerTick, 15 * 60 * 1000); // 15分ごとに判定
    setTimeout(schedulerTick, 20 * 1000); // 起動20秒後に一度
  })
  .catch((err) => {
    console.error("DB初期化に失敗しました:", err.message);
    process.exit(1);
  });
