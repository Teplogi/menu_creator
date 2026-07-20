import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import Anthropic from "@anthropic-ai/sdk";
import Stripe from "stripe";
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
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"], // onclick 等のインラインハンドラを許可（既定の'none'だとUIが壊れる）
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
        formAction: ["'self'"],
        manifestSrc: ["'self'"],
        upgradeInsecureRequests: null, // localhost(http)開発を壊さないため無効
      },
    },
    // 別オリジンのアイコン等は無いが、将来のCDN埋め込みに備えて緩めに
    crossOriginEmbedderPolicy: false,
  })
);
// Stripe Webhook は署名検証に「生ボディ」が必要なため、express.json より前に生パーサで登録する。
// （handleStripeWebhook は関数宣言なので巻き上げにより参照可能）
app.post("/api/billing/webhook", express.raw({ type: "*/*" }), handleStripeWebhook);
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const client = new Anthropic(); // ANTHROPIC_API_KEY を環境変数から読み込む

// ---------- Stripe（課金 / フリーミアム） ----------
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || null;
// 無料ユーザーが月に生成できる「食数」（回数ではなく、生成した食事の数で数える）
const FREE_AI_MEALS_PER_MONTH = Number(process.env.FREE_AI_MEALS_PER_MONTH) || 10;
// 課金が有効なのは「秘密鍵」と「価格ID」が両方そろっているときだけ。
// 未設定の間は AI 生成を全ユーザーに開放する（開発・公開前でも普通に使える）。
const billingEnabled = () => !!(stripe && STRIPE_PRICE_ID);
if (!billingEnabled()) {
  console.log("（課金は未設定: STRIPE_SECRET_KEY / STRIPE_PRICE_ID 未設定のため、AI生成は全開放されます）");
}

const currentYM = () => new Date().toISOString().slice(0, 7); // "YYYY-MM"
async function hasActiveEntitlement(userId) {
  const e = await one("SELECT status, current_period_end FROM entitlements WHERE user_id = $1", [userId]);
  if (!e || e.status !== "active") return false;
  if (e.current_period_end && e.current_period_end < new Date().toISOString()) return false;
  return true;
}
async function getAiUsage(userId) {
  const r = await one("SELECT count FROM ai_usage WHERE user_id = $1 AND ym = $2", [userId, currentYM()]);
  return r ? r.count : 0;
}
async function incAiUsage(userId, n = 1) {
  await q(
    `INSERT INTO ai_usage (user_id, ym, count) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, ym) DO UPDATE SET count = ai_usage.count + $3`,
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
function requireAi(costFn) {
  return async (req, res, next) => {
    try {
      if (!billingEnabled()) { req.aiPaid = true; return next(); }
      if (await hasActiveEntitlement(req.user.id)) { req.aiPaid = true; return next(); }
      const cost = Math.max(1, costFn ? costFn(req) : 1);
      const used = await getAiUsage(req.user.id);
      const remaining = Math.max(0, FREE_AI_MEALS_PER_MONTH - used);
      if (cost > remaining) {
        return res.status(402).json({
          code: "UPGRADE_REQUIRED",
          error:
            remaining <= 0
              ? `今月の無料AI生成（${FREE_AI_MEALS_PER_MONTH}食）を使い切りました。プレミアムにアップグレードすると使い放題です。`
              : `今回の生成（${cost}食分）は無料枠の残り（${remaining}食）を超えます。期間を短くするか、プレミアムで使い放題に。`,
          freeLimit: FREE_AI_MEALS_PER_MONTH,
          freeRemaining: remaining,
          requested: cost,
        });
      }
      req.aiPaid = false;
      req.aiCost = cost;
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
  `CREATE INDEX IF NOT EXISTS idx_plans_household ON meal_plans (household_id, created_at DESC)`,
  // 課金: 加入状態（provider 列で将来 RevenueCat 等も同居可能）
  `CREATE TABLE IF NOT EXISTS entitlements (
    user_id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'stripe',
    status TEXT NOT NULL DEFAULT 'inactive', plan TEXT,
    stripe_customer_id TEXT, stripe_subscription_id TEXT,
    current_period_end TEXT, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_entitlements_customer ON entitlements (stripe_customer_id)`,
  // 無料枠カウンタ（ユーザー×年月）
  `CREATE TABLE IF NOT EXISTS ai_usage (
    user_id TEXT NOT NULL, ym TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, ym))`,
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
    const user = sess ? await one("SELECT id, username FROM users WHERE id = $1", [sess.user_id]) : null;
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
  if (!hh) { res.status(404).json({ error: "世帯が見つかりません。" }); return null; }
  if (!(await isMember(req.user.id, hh.id))) { res.status(403).json({ error: "この世帯へのアクセス権がありません。" }); return null; }
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
};

// ---------- 生成ロジック ----------
function buildPrompt(targets, opts, { avoidDishes = [], recentDishes = [] } = {}) {
  const { people, maxCookMinutes, dishCount, preferences, avoid } = opts;
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
    maxCookMinutes
      ? `各料理は調理時間の目安が ${maxCookMinutes} 分以内になるようにし、cook_minutes に目安（分）の数値を入れる。`
      : "各料理の cook_minutes に調理時間の目安（分）の数値を入れる。",
    preferences ? `好み・要望: ${preferences}` : "好み・要望: 特になし（栄養バランスよく、和洋中を織り交ぜる）",
    avoid ? `避けたい食材・アレルギー: ${avoid}（絶対に使用しない）` : "",
    avoidDishes && avoidDishes.length
      ? `次の料理名とは重複させないこと: ${avoidDishes.join("、")}`
      : "",
    recentDishes && recentDishes.length
      ? `この世帯が最近作った料理です。マンネリを避けるため、これらとは違う料理・味付け・ジャンルを優先すること: ${recentDishes.join("、")}`
      : "",
    "",
    "【バリエーションのルール（重要）】",
    "- 主菜の主材料を分散させる（肉類・魚介・卵・大豆製品・野菜中心などを偏らせない）。連日で同じ主材料を続けない。",
    "- 調理法を分散させる（焼く・煮る・炒める・揚げる・蒸す・和える 等をローテーション）。",
    "- ジャンルを織り交ぜる（和食・洋食・中華・エスニック 等）。",
    "- 味付けが単調にならないようにする（醤油ベースばかりにしない）。",
    "- ありきたりな定番だけでなく、作りやすい範囲で目新しい一皿も混ぜる。",
    "",
    "【食材を使い切るルール（重要）】",
    "- 余りやすい食材（白菜・大根・キャベツ・長ねぎ・にんじん・きのこ・豆腐・ひき肉など、1回で使い切りにくいもの）は、期間内の複数の献立で使い回して使い切るように計画する。",
    "- 生鮮食品（葉物野菜・魚など傷みやすいもの）は期間の前半に、日持ちする食材（根菜・乾物・冷凍可のもの）は後半に寄せる。",
    "- 特売でまとめ買いしやすい食材を、無駄が出ない範囲で活用する。",
    "",
    "その他のルール:",
    "- 各 dish の role は「主菜」「副菜」「汁物」のいずれかにする。",
    "- 材料は name（食材名）・amount（分量）・category（分類）に分ける。category は指定の6分類から正しく選び、常備調味料は必ず「調味料」にする。",
    "- 手順は簡潔な箇条書きにする。",
    "- すべて日本語で出力する。",
  ]
    .filter(Boolean)
    .join("\n");
}

async function generate(targets, opts, diversity = {}) {
  const stream = client.messages.stream({
    model: "claude-opus-4-8",
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
  return toolBlock.input; // { days: [...] }
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
    "【今の料理（これを置き換える）】",
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
    "- role は「主菜」「副菜」「汁物」のいずれか。",
    "- 材料は name（食材名）・amount（分量）・category（分類）に分ける。category は 野菜・果物 / 肉・魚 / 卵・乳・豆腐 / 主食・乾物 / 調味料 / その他 から選び、常備調味料と水・お湯は必ず「調味料」にする。",
    "- 手順は簡潔な箇条書き。すべて日本語。",
    "- 料理は1品だけ、save_dish ツールで返す。",
  ]
    .filter(Boolean)
    .join("\n");
}

async function generateDish(instruction, ctx) {
  const stream = client.messages.stream({
    model: "claude-opus-4-8",
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
  return toolBlock.input.dish;
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

// 直近プランの料理名を集めて、マンネリ回避のヒントにする
async function getRecentDishNames(householdId, planLimit = 5, cap = 40) {
  const rows = await all(
    "SELECT data_json FROM meal_plans WHERE household_id = $1 ORDER BY created_at DESC LIMIT $2",
    [householdId, planLimit]
  );
  const names = [];
  for (const r of rows) {
    try {
      for (const day of JSON.parse(r.data_json).days || [])
        for (const meal of day.meals || [])
          for (const dish of meal.dishes || []) if (dish.name) names.push(dish.name);
    } catch {}
  }
  return [...new Set(names)].slice(0, cap);
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
const userToClient = (u) => ({ id: u.id, username: u.username });
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
    res.json({ token: await createSession(id), user: { id, username } });
  } catch (err) {
    handleError(res, err);
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const username = (req.body?.username || "").toString().trim();
    const password = (req.body?.password || "").toString();
    const u = await one("SELECT * FROM users WHERE username_lc = $1", [username.toLowerCase()]);
    if (!u || !verifyPassword(password, u.pw_hash))
      return res.status(401).json({ error: "ユーザー名またはパスワードが違います。" });
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
    res.json({ user: req.user, households: await householdsOf(req.user.id) });
  } catch (err) {
    handleError(res, err);
  }
});

// ---------- 世帯 API（認証必須） ----------
app.post("/api/households", auth, async (req, res) => {
  try {
    const name = (req.body?.name || `${req.user.username}の世帯`).toString().slice(0, 40);
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

app.get("/api/households/:id/members", auth, async (req, res) => {
  try {
    if (!(await requireMember(req, res, req.params.id))) return;
    const members = await all(
      `SELECT u.username, m.role FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.household_id = $1 ORDER BY m.created_at`,
      [req.params.id]
    );
    res.json(members);
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

// 旧・共有トークンの世帯を自分のアカウントに取り込む（移行用）
app.post("/api/households/claim", auth, async (req, res) => {
  try {
    const token = (req.body?.shareToken || "").toString().trim();
    const hh = await one("SELECT * FROM households WHERE share_token = $1", [token]);
    if (!hh) return res.status(404).json({ error: "世帯が見つかりません。" });
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

app.post("/api/plans", auth, aiLimiter, requireAi((req) => aiCostFromTargets(req.body?.targets)), async (req, res) => {
  try {
    const { householdId, targets, people, maxCookMinutes, dishCount, preferences, avoid } =
      req.body || {};
    const household = await requireMember(req, res, householdId);
    if (!household) return;

    const vErr = validateTargets(targets);
    if (vErr) return res.status(400).json({ error: vErr });

    const opts = {
      people: Number(people) > 0 ? Number(people) : 2,
      maxCookMinutes: Number(maxCookMinutes) > 0 ? Number(maxCookMinutes) : null,
      dishCount: dishCount || "main_side",
      preferences: (preferences || "").toString().trim(),
      avoid: (avoid || "").toString().trim(),
    };

    const recentDishes = await getRecentDishNames(household.id);
    const plan = await generate(targets, opts, { recentDishes });

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
    if (!req.aiPaid) await incAiUsage(req.user.id, req.aiCost || 1); // 無料は成功時のみ食数分を消費
    res.json(planToClient(row));
  } catch (err) {
    handleError(res, err);
  }
});

// AIを使わず空の献立を作る（手打ち入力用・APIキー不要）
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
app.post("/api/plans/:id/regenerate", auth, aiLimiter, requireAi(() => 1), async (req, res) => {
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

    const regenerated = await generate([{ date, slots: [slot] }], opts, {
      avoidDishes,
      recentDishes,
    });
    const newDishes = regenerated.days?.[0]?.meals?.[0]?.dishes;
    if (!newDishes) throw new Error("EMPTY_RESPONSE");

    meal.dishes = newDishes;
    const updated = await one(
      "UPDATE meal_plans SET data_json = $1 WHERE id = $2 RETURNING *",
      [JSON.stringify(data), row.id]
    );
    if (!req.aiPaid) await incAiUsage(req.user.id, req.aiCost || 1);
    res.json(planToClient(updated));
  } catch (err) {
    handleError(res, err);
  }
});

// 料理名・指示を指定して、その1品だけをAIで差し替え（機能5）
app.post("/api/plans/:id/replace-dish", auth, aiLimiter, requireAi(() => 1), async (req, res) => {
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
    const newDish = await generateDish(instr, {
      people: row.people,
      maxCookMinutes: opts?.maxCookMinutes,
      preferences: opts?.preferences,
      avoid: opts?.avoid,
      current,
      others,
    });

    meal.dishes[idx] = newDish;
    const updated = await one(
      "UPDATE meal_plans SET data_json = $1 WHERE id = $2 RETURNING *",
      [JSON.stringify(data), row.id]
    );
    if (!req.aiPaid) await incAiUsage(req.user.id, req.aiCost || 1);
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
    const used = await getAiUsage(req.user.id);
    res.json({
      billingEnabled: billingEnabled(),
      active,
      plan: active ? e?.plan || "monthly" : null,
      currentPeriodEnd: active ? e?.current_period_end || null : null,
      freeLimit: FREE_AI_MEALS_PER_MONTH,
      freeUsed: used,
      freeRemaining: Math.max(0, FREE_AI_MEALS_PER_MONTH - used),
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

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`めにゅらく！ 起動: http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("DB初期化に失敗しました:", err.message);
    process.exit(1);
  });
