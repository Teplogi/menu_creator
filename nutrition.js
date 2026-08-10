// 献立の栄養計算。日本食品標準成分表（文部科学省）のデータを使って、
// 材料名＋分量から kcal・PFC・食物繊維・食塩相当量を見積もる。
// 生成される分量表記は「1/2個(100g)」「200g」「大さじ2」に統一済みなので、それを前提に換算する。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(DIR, p), "utf8"));

const TABLE = readJson("data/nutrition.json");
const MAP = readJson("data/nutrition-map.json");

const FOODS = new Map(TABLE.foods.map((f) => [f.id, f]));

// ---------- 表記ゆれの吸収 ----------
// 全角→半角、カタカナ→ひらがな、記号と調理指示（みじん切り等）を落として比較用の文字列にする。
const PREP_WORDS = /(みじん切り|千切り|せん切り|薄切り|うすぎり|乱切り|ざく切り|くし切り|輪切り|そぎ切り|一口大|ひとくちだい|お好み|好みで|下ゆで|水煮|冷凍|生の|新鮮な|市販の|お好きな)/g;
function norm(s) {
  return String(s || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[（(][^）)]*[）)]/g, "") // 括弧書きは落とす
    .replace(PREP_WORDS, "")
    .replace(/[\s・,、.。/／|｜'"’”`~〜－-]/g, "") // 「ー」は伸ばし棒なので残す（ベーコン等）
    .toLowerCase();
}

// 対応表のキーも同じ正規化を通しておく（照合の左右で表記を揃えるため）。
// 長いキーを優先（「鶏もも肉」を「鶏肉」より先に当てる）。
const normEntries = (obj) =>
  Object.entries(obj)
    .map(([k, v]) => [norm(k), v])
    .filter(([k]) => k)
    .sort((a, b) => b[0].length - a[0].length);
const ALIASES = normEntries(MAP.aliases);
const PIECE = normEntries(MAP.pieceWeights);
const SPOON_BY_FOOD = normEntries(MAP.spoonGrams.byFood);
// 栄養に影響しない材料（水・揚げ油など）。計算からも不明件数からも外す。
const IGNORE = (MAP.ignore || []).map(norm).filter(Boolean);
const isIgnored = (nameKey) => IGNORE.some((w) => nameKey === w || nameKey.startsWith(w + "の") || nameKey.endsWith(w));

// ---------- 材料名 → 食品 ----------
const matchCache = new Map();
function findFood(name) {
  const key = norm(name);
  if (!key) return null;
  if (matchCache.has(key)) return matchCache.get(key);
  let hit = null;
  for (const [alias, id] of ALIASES) {
    if (key.includes(alias)) { hit = FOODS.get(id) || null; break; }
  }
  matchCache.set(key, hit);
  return hit;
}

// ---------- 分量 → グラム ----------
const NUM = "\\d+(?:\\.\\d+)?と\\d+\\s*/\\s*\\d+|\\d+\\s*/\\s*\\d+|\\d+(?:\\.\\d+)?";
function parseNum(s) {
  const t = String(s || "").trim();
  let m = t.match(/^(\d+(?:\.\d+)?)と(\d+)\s*\/\s*(\d+)$/);
  if (m) return parseFloat(m[1]) + Number(m[2]) / Number(m[3]);
  m = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]);
  m = t.match(/^(\d+(?:\.\d+)?)$/);
  return m ? parseFloat(m[1]) : NaN;
}
function pieceWeight(nameKey, unit) {
  for (const [k, units] of PIECE) if (nameKey.includes(k) && units[unit] != null) return units[unit];
  return null;
}
function spoonGram(nameKey, unit) {
  for (const [k, g] of SPOON_BY_FOOD) if (nameKey.includes(k)) {
    return unit === "大さじ" ? g : unit === "小さじ" ? g / 3 : g * (200 / 15);
  }
  return MAP.spoonGrams.default[unit] ?? null;
}
// 返り値 { grams, exact } exact=false は目安（個数から推定など）
function toGrams(amount, name) {
  const t = String(amount || "").trim();
  const key = norm(name);
  if (!t) return { grams: 0, exact: false };

  // 「1/2個(100g)」のように括弧内に重量がある場合はそれを最優先
  let m = t.match(/[（(]\s*(\d+(?:\.\d+)?)\s*(g|ｇ)\s*[）)]/i);
  if (m) return { grams: parseFloat(m[1]), exact: true };

  m = t.match(new RegExp(`^(${NUM})\\s*(kg|g|ml|cc|ｇ)$`, "i"));
  if (m) {
    const n = parseNum(m[1]);
    if (!isNaN(n)) {
      const u = m[2].toLowerCase();
      return { grams: u === "kg" ? n * 1000 : n, exact: true }; // ml/cc は水と同じ重さとみなす
    }
  }

  m = t.match(new RegExp(`^(大さじ|小さじ|カップ)\\s*(${NUM})$`));
  if (m) {
    const n = parseNum(m[2]);
    const g = spoonGram(key, m[1]);
    if (!isNaN(n) && g != null) return { grams: n * g, exact: false };
  }

  m = t.match(new RegExp(`^(${NUM})\\s*(個|本|枚|袋|束|株|丁|片|かけ|パック|切れ|尾|房|玉|缶|節)`));
  if (m) {
    const n = parseNum(m[1]);
    const w = pieceWeight(key, m[2]);
    if (!isNaN(n)) return { grams: n * (w ?? 100), exact: false }; // 未知の食材は1個100gとみなす
  }

  for (const [word, g] of Object.entries(MAP.vagueGrams)) if (t.includes(word)) return { grams: g, exact: false };
  return { grams: 0, exact: false };
}

// ---------- 集計 ----------
// 1材料の上限。これを超えたら照合ミス・分量の取り違えとみなして計算から外す
// （人数で割る前の、料理1品ぶんの値で判定する）。
const SANITY = { salt: 25, kcal: 4000 };
const ZERO = () => ({ kcal: 0, p: 0, f: 0, c: 0, fiber: 0, salt: 0 });
const addInto = (acc, n) => { for (const k of Object.keys(acc)) acc[k] += n[k] || 0; return acc; };
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const roundAll = (n) => ({
  kcal: Math.round(n.kcal), p: round(n.p), f: round(n.f), c: round(n.c),
  fiber: round(n.fiber), salt: round(n.salt, 2),
});

// 1品ぶんの栄養。people で割って1人分にする。
function dishNutrition(dish, people) {
  const total = ZERO();
  let known = 0, unknown = 0;
  const missing = [];
  for (const ing of dish.ingredients || []) {
    if (!ing?.name) continue;
    if (isIgnored(norm(ing.name))) continue; // 水・揚げ油などは計算しない
    const food = findFood(ing.name);
    const { grams } = toGrams(ing.amount, ing.name);
    if (!food || !grams) {
      // 調味料の「少々」など0gのものは不明としてカウントしない
      if (!food && grams !== 0) { unknown++; missing.push(ing.name); }
      else if (!food && !String(ing.amount || "").trim()) { unknown++; missing.push(ing.name); }
      continue;
    }
    const r = grams / 100;
    const add = {
      kcal: food.kcal * r, p: food.p * r, f: food.f * r,
      c: food.c * r, fiber: food.fiber * r, salt: food.salt * r,
    };
    // 安全弁: 1つの材料から出るはずのない量になったら、照合か分量の取り違えとみなして除外する
    // （例: 液体の「だし汁400ml」を粉末だしとして数えると塩分が160gになる）
    if (add.salt > SANITY.salt || add.kcal > SANITY.kcal) {
      unknown++; missing.push(ing.name);
      continue;
    }
    addInto(total, add);
    known++;
  }
  const per = ZERO();
  const div = Math.max(1, Number(people) || 1);
  for (const k of Object.keys(total)) per[k] = total[k] / div;
  return { ...roundAll(per), known, unknown, missing };
}

// PFCバランス（エネルギー比）。たんぱく質4kcal/g・脂質9kcal/g・炭水化物4kcal/g。
function pfcRatio(n) {
  const pk = n.p * 4, fk = n.f * 9, ck = n.c * 4;
  const sum = pk + fk + ck;
  if (sum <= 0) return { p: 0, f: 0, c: 0 };
  return { p: Math.round((pk / sum) * 100), f: Math.round((fk / sum) * 100), c: Math.round((ck / sum) * 100) };
}

// プラン全体の栄養を、日ごと・食事ごと・料理ごとに計算する
export function analyzePlan(plan, people) {
  const days = [];
  const totalAll = ZERO();
  let unknownTotal = 0;
  const missingAll = new Map();

  for (const day of plan?.days || []) {
    const dayTotal = ZERO();
    const meals = [];
    for (const meal of day.meals || []) {
      const mealTotal = ZERO();
      const dishes = [];
      for (const dish of meal.dishes || []) {
        const n = dishNutrition(dish, people);
        dishes.push({ name: dish.name, role: dish.role || "", ...n });
        addInto(mealTotal, n);
        unknownTotal += n.unknown;
        for (const m of n.missing) missingAll.set(m, (missingAll.get(m) || 0) + 1);
      }
      meals.push({ slot: meal.slot, ...roundAll(mealTotal), pfc: pfcRatio(mealTotal), dishes });
      addInto(dayTotal, mealTotal);
    }
    days.push({ date: day.date, ...roundAll(dayTotal), pfc: pfcRatio(dayTotal), meals });
    addInto(totalAll, dayTotal);
  }

  const dayCount = Math.max(1, days.length);
  const avg = ZERO();
  for (const k of Object.keys(totalAll)) avg[k] = totalAll[k] / dayCount;

  return {
    source: TABLE.source,
    people: Math.max(1, Number(people) || 1),
    days,
    average: { ...roundAll(avg), pfc: pfcRatio(avg) },
    total: { ...roundAll(totalAll), pfc: pfcRatio(totalAll) },
    unknownCount: unknownTotal,
    missing: [...missingAll.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name]) => name),
  };
}

// 別名表（正規化済みキー → 食品番号）。画面側で「玉ねぎ」と「たまねぎ」を
// 同じ food として扱うために使う。
export function foodAliasMap() {
  return Object.fromEntries(ALIASES);
}

// 1個・大さじ1が何グラムか。買い物リストで「1かけ＋小さじ1」のように
// 単位が混ざったものを、いったんグラムにしてから1つの表記へまとめるのに使う。
export function foodUnitTables() {
  return { pieceWeights: MAP.pieceWeights, spoonGrams: MAP.spoonGrams };
}

export const _internals = { norm, findFood, toGrams, pfcRatio };
