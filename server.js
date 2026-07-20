import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const client = new Anthropic(); // ANTHROPIC_API_KEY を環境変数から読み込む

const MAX_DAYS = 14;
const MAX_SLOTS = 42; // 生成量の上限（14日 × 3食）

// ---------- DB 初期化 ----------
const db = new DatabaseSync(process.env.DB_PATH || "data.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY,
    name TEXT,
    share_token TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meal_plans (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT,
    people INTEGER,
    max_cook_minutes INTEGER,
    dish_count TEXT,
    preferences TEXT,
    avoid TEXT,
    input_json TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    username_lc TEXT UNIQUE NOT NULL,
    pw_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memberships (
    household_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TEXT NOT NULL,
    PRIMARY KEY (household_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS pantry_items (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL,
    name TEXT NOT NULL,
    name_norm TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pantry_hh_norm ON pantry_items (household_id, name_norm);
`);

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
function createSession(userId) {
  const token = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(
    token,
    userId,
    new Date().toISOString()
  );
  return token;
}
// 認証必須ミドルウェア（req.user をセット）
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  const sess = token && db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  const user = sess && db.prepare("SELECT id, username FROM users WHERE id = ?").get(sess.user_id);
  if (!user) return res.status(401).json({ error: "ログインが必要です。" });
  req.user = user;
  next();
}
function isMember(userId, householdId) {
  return !!db
    .prepare("SELECT 1 FROM memberships WHERE user_id = ? AND household_id = ?")
    .get(userId, householdId);
}
// req.user が householdId のメンバーであることを要求。OKなら household 行を返す
function requireMember(req, res, householdId) {
  const hh = db.prepare("SELECT * FROM households WHERE id = ?").get(householdId);
  if (!hh) { res.status(404).json({ error: "世帯が見つかりません。" }); return null; }
  if (!isMember(req.user.id, hh.id)) { res.status(403).json({ error: "この世帯へのアクセス権がありません。" }); return null; }
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
function getRecentDishNames(householdId, planLimit = 5, cap = 40) {
  const rows = db
    .prepare(
      "SELECT data_json FROM meal_plans WHERE household_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(householdId, planLimit);
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
const householdsOf = (userId) =>
  db.prepare(
    `SELECT h.id, h.name FROM households h JOIN memberships m ON m.household_id = h.id
     WHERE m.user_id = ? ORDER BY m.created_at`
  ).all(userId);

app.post("/api/auth/register", (req, res) => {
  try {
    const username = (req.body?.username || "").toString().trim();
    const password = (req.body?.password || "").toString();
    if (username.length < 2 || username.length > 20)
      return res.status(400).json({ error: "ユーザー名は2〜20文字にしてください。" });
    if (password.length < 6)
      return res.status(400).json({ error: "パスワードは6文字以上にしてください。" });
    const lc = username.toLowerCase();
    if (db.prepare("SELECT 1 FROM users WHERE username_lc = ?").get(lc))
      return res.status(409).json({ error: "そのユーザー名は既に使われています。" });
    const id = randomUUID();
    db.prepare(
      "INSERT INTO users (id, username, username_lc, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(id, username, lc, hashPassword(password), new Date().toISOString());
    res.json({ token: createSession(id), user: { id, username } });
  } catch (err) {
    handleError(res, err);
  }
});

app.post("/api/auth/login", (req, res) => {
  try {
    const username = (req.body?.username || "").toString().trim();
    const password = (req.body?.password || "").toString();
    const u = db.prepare("SELECT * FROM users WHERE username_lc = ?").get(username.toLowerCase());
    if (!u || !verifyPassword(password, u.pw_hash))
      return res.status(401).json({ error: "ユーザー名またはパスワードが違います。" });
    res.json({ token: createSession(u.id), user: userToClient(u) });
  } catch (err) {
    handleError(res, err);
  }
});

app.post("/api/auth/logout", auth, (req, res) => {
  const token = (req.headers.authorization || "").slice(7);
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  res.json({ ok: true });
});

app.get("/api/auth/me", auth, (req, res) => {
  res.json({ user: req.user, households: householdsOf(req.user.id) });
});

// ---------- 世帯 API（認証必須） ----------
app.post("/api/households", auth, (req, res) => {
  try {
    const name = (req.body?.name || `${req.user.username}の世帯`).toString().slice(0, 40);
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO households (id, name, share_token, created_at) VALUES (?, ?, ?, ?)").run(
      id, name, randomBytes(12).toString("base64url"), now
    );
    db.prepare("INSERT INTO memberships (household_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(
      id, req.user.id, "owner", now
    );
    res.json({ id, name });
  } catch (err) {
    handleError(res, err);
  }
});

app.get("/api/households", auth, (req, res) => {
  res.json(householdsOf(req.user.id));
});

app.get("/api/households/:id/members", auth, (req, res) => {
  if (!requireMember(req, res, req.params.id)) return;
  const members = db.prepare(
    `SELECT u.username, m.role FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.household_id = ? ORDER BY m.created_at`
  ).all(req.params.id);
  res.json(members);
});

// 共同編集者をユーザー名で招待
app.post("/api/households/:id/members", auth, (req, res) => {
  if (!requireMember(req, res, req.params.id)) return;
  const uname = (req.body?.username || "").toString().trim();
  const target = db.prepare("SELECT * FROM users WHERE username_lc = ?").get(uname.toLowerCase());
  if (!target) return res.status(404).json({ error: "そのユーザーは見つかりません。" });
  if (isMember(target.id, req.params.id)) return res.status(409).json({ error: "すでにメンバーです。" });
  db.prepare("INSERT INTO memberships (household_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(
    req.params.id, target.id, "member", new Date().toISOString()
  );
  res.json({ ok: true, username: target.username });
});

// ---------- 常備品リスト（世帯ごと・共有） ----------
app.get("/api/households/:id/pantry", auth, (req, res) => {
  if (!requireMember(req, res, req.params.id)) return;
  const rows = db.prepare(
    "SELECT id, name FROM pantry_items WHERE household_id = ? ORDER BY created_at"
  ).all(req.params.id);
  res.json(rows);
});

app.post("/api/households/:id/pantry", auth, (req, res) => {
  if (!requireMember(req, res, req.params.id)) return;
  const name = (req.body?.name || "").toString().trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: "食材名を入力してください。" });
  const norm = normName(name);
  const existing = db.prepare(
    "SELECT id, name FROM pantry_items WHERE household_id = ? AND name_norm = ?"
  ).get(req.params.id, norm);
  if (existing) return res.json(existing); // 重複は既存を返す（冪等）
  const id = randomUUID();
  db.prepare(
    "INSERT INTO pantry_items (id, household_id, name, name_norm, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, req.params.id, name, norm, new Date().toISOString());
  res.json({ id, name });
});

app.delete("/api/households/:id/pantry/:itemId", auth, (req, res) => {
  if (!requireMember(req, res, req.params.id)) return;
  db.prepare("DELETE FROM pantry_items WHERE id = ? AND household_id = ?").run(
    req.params.itemId, req.params.id
  );
  res.json({ ok: true });
});

// 旧・共有トークンの世帯を自分のアカウントに取り込む（移行用）
app.post("/api/households/claim", auth, (req, res) => {
  const token = (req.body?.shareToken || "").toString().trim();
  const hh = db.prepare("SELECT * FROM households WHERE share_token = ?").get(token);
  if (!hh) return res.status(404).json({ error: "世帯が見つかりません。" });
  if (!isMember(req.user.id, hh.id)) {
    db.prepare("INSERT INTO memberships (household_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(
      hh.id, req.user.id, "member", new Date().toISOString()
    );
  }
  res.json({ id: hh.id, name: hh.name });
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
function loadPlanForUser(req, res) {
  const row = db.prepare("SELECT * FROM meal_plans WHERE id = ?").get(req.params.id);
  if (!row) { res.status(404).json({ error: "プランが見つかりません。" }); return null; }
  if (!isMember(req.user.id, row.household_id)) { res.status(403).json({ error: "アクセス権がありません。" }); return null; }
  return row;
}

app.post("/api/plans", auth, async (req, res) => {
  try {
    const { householdId, targets, people, maxCookMinutes, dishCount, preferences, avoid } =
      req.body || {};
    const household = requireMember(req, res, householdId);
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

    const recentDishes = getRecentDishNames(household.id);
    const plan = await generate(targets, opts, { recentDishes });

    const dates = targets.map((t) => t.date).sort();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO meal_plans
       (id, household_id, start_date, end_date, people, max_cook_minutes, dish_count,
        preferences, avoid, input_json, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
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
      new Date().toISOString()
    );

    res.json(planToClient(db.prepare("SELECT * FROM meal_plans WHERE id = ?").get(id)));
  } catch (err) {
    handleError(res, err);
  }
});

// AIを使わず空の献立を作る（手打ち入力用・APIキー不要）
app.post("/api/plans/manual", auth, (req, res) => {
  try {
    const { householdId, targets, people, dishCount } = req.body || {};
    const household = requireMember(req, res, householdId);
    if (!household) return;
    const vErr = validateTargets(targets);
    if (vErr) return res.status(400).json({ error: vErr });

    const p = Number(people) > 0 ? Math.min(12, Number(people)) : 2;
    const days = targets
      .map((t) => ({ date: t.date, meals: t.slots.map((slot) => ({ slot, dishes: [] })) }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const dates = targets.map((t) => t.date).sort();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO meal_plans
       (id, household_id, start_date, end_date, people, max_cook_minutes, dish_count,
        preferences, avoid, input_json, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, household.id, dates[0], dates[dates.length - 1], p, null, dishCount || "main_side",
      "", "",
      JSON.stringify({ targets, opts: { people: p, manual: true } }),
      JSON.stringify({ days }),
      new Date().toISOString()
    );
    res.json(planToClient(db.prepare("SELECT * FROM meal_plans WHERE id = ?").get(id)));
  } catch (err) {
    handleError(res, err);
  }
});

app.get("/api/plans", auth, (req, res) => {
  const household = requireMember(req, res, req.query.householdId);
  if (!household) return;
  const rows = db
    .prepare(
      "SELECT * FROM meal_plans WHERE household_id = ? ORDER BY created_at DESC LIMIT 100"
    )
    .all(household.id);
  res.json(rows.map(planToClient));
});

app.get("/api/plans/:id", auth, (req, res) => {
  const row = loadPlanForUser(req, res);
  if (!row) return;
  res.json(planToClient(row));
});

// 献立の手動編集を保存（days をまるごと差し替え、任意で people 更新）
app.post("/api/plans/:id", auth, (req, res) => {
  try {
    const row = loadPlanForUser(req, res);
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
    db.prepare("UPDATE meal_plans SET data_json = ?, people = ?, start_date = ?, end_date = ? WHERE id = ?").run(
      JSON.stringify({ days }),
      p,
      start,
      end,
      row.id
    );
    res.json(planToClient(db.prepare("SELECT * FROM meal_plans WHERE id = ?").get(row.id)));
  } catch (err) {
    handleError(res, err);
  }
});

// 献立の削除
app.delete("/api/plans/:id", auth, (req, res) => {
  const row = loadPlanForUser(req, res);
  if (!row) return;
  db.prepare("DELETE FROM meal_plans WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

// 1食だけ作り直し
app.post("/api/plans/:id/regenerate", auth, async (req, res) => {
  try {
    const { date, slot } = req.body || {};
    const row = loadPlanForUser(req, res);
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
    const recentDishes = getRecentDishNames(row.household_id);

    const regenerated = await generate([{ date, slots: [slot] }], opts, {
      avoidDishes,
      recentDishes,
    });
    const newDishes = regenerated.days?.[0]?.meals?.[0]?.dishes;
    if (!newDishes) throw new Error("EMPTY_RESPONSE");

    meal.dishes = newDishes;
    db.prepare("UPDATE meal_plans SET data_json = ? WHERE id = ?").run(
      JSON.stringify(data),
      row.id
    );

    res.json(planToClient(db.prepare("SELECT * FROM meal_plans WHERE id = ?").get(row.id)));
  } catch (err) {
    handleError(res, err);
  }
});

// 料理名・指示を指定して、その1品だけをAIで差し替え（機能5）
app.post("/api/plans/:id/replace-dish", auth, async (req, res) => {
  try {
    const { date, slot, dishIndex, instruction } = req.body || {};
    const instr = (instruction || "").toString().trim();
    if (!instr) return res.status(400).json({ error: "どんな料理にするか入力してください。" });
    const row = loadPlanForUser(req, res);
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
    db.prepare("UPDATE meal_plans SET data_json = ? WHERE id = ?").run(
      JSON.stringify(data),
      row.id
    );
    res.json(planToClient(db.prepare("SELECT * FROM meal_plans WHERE id = ?").get(row.id)));
  } catch (err) {
    handleError(res, err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`めにゅらく！ 起動: http://localhost:${PORT}`);
});
