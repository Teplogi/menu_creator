// 料理カタログからの候補出し。
// 献立の条件（調理時間・主食・避けたい食材・主材料の割り当てなど）でコードが機械的に絞り、
// 残った候補をAIに渡して「この中から選ぶ」形にする。
// コードで絞る理由は、時間や除外食材のような約束は確実に守りたいから。
// AIに選ばせる理由は、「子どもが食べやすいもの」のような自由入力の要望はタグでは拾えないから。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _internals } from "./nutrition.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(fs.readFileSync(path.join(DIR, "data/dish-catalog.json"), "utf8"));
const DISHES = DOC.dishes || [];
const norm = _internals.norm;

// 候補が少なすぎると毎回同じ献立になるので、この数を割ったら条件を緩める
const MIN_CANDIDATES = 12;
// AIに渡す数。多すぎるとプロンプトが膨らみ、少なすぎると選択の幅が無くなる
const MAX_CANDIDATES = 24;

// 主材料ローテーションのラベル → カタログの main
// ラベルの先頭で見る。「豆腐・厚揚げ・卵（肉やひき肉と…）」のように
// 説明文に他の食材名が入るので、部分一致だと取り違える。
const MAIN_MAP = [
  [/^鶏肉/, ["鶏肉"]],
  [/^豚肉/, ["豚肉"]],
  [/^魚介/, ["魚介"]],
  [/^牛肉/, ["牛肉", "ひき肉"]],
  [/^豆腐/, ["卵", "豆腐大豆"]],
  [/^野菜/, ["野菜"]],
];
const mainsFor = (hint) => (MAIN_MAP.find(([re]) => re.test(String(hint || "").trim())) || [])[1] || null;

// 主材料ごとに順番に拾って、候補が特定の主材料に偏らないようにする。
// カタログは主材料ごとに並んでいるので、先頭から切ると鶏肉ばかりになってしまう。
// 開始位置は食事ごとにずらす（同じ条件でも毎回同じ顔ぶれにならないように）。
function spread(list, limit, seed) {
  const groups = new Map();
  for (const d of list) {
    if (!groups.has(d.main)) groups.set(d.main, []);
    groups.get(d.main).push(d);
  }
  const keys = [...groups.keys()].sort();
  const rot = keys.length ? seed % keys.length : 0;
  const arrs = [...keys.slice(rot), ...keys.slice(0, rot)].map((k) => {
    const g = groups.get(k);
    const s = g.length ? seed % g.length : 0;
    return [...g.slice(s), ...g.slice(0, s)];
  });
  const out = [];
  for (let i = 0; out.length < limit; i++) {
    let any = false;
    for (const a of arrs) {
      if (!a[i]) continue;
      out.push(a[i]); any = true;
      if (out.length >= limit) break;
    }
    if (!any) break;
  }
  return out;
}
const seedOf = (s) => { let h = 0; for (const ch of String(s || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };

const SLOT_CHAR = { 朝食: "朝", 昼食: "昼", 夕食: "夕" };
const STAPLE_JA = { rice: "ご飯", noodle: "麺", bread: "パン" };
const seasonOf = (dateStr) => {
  const m = Number(String(dateStr || "").slice(5, 7));
  if (m >= 3 && m <= 5) return "春";
  if (m >= 6 && m <= 8) return "夏";
  if (m >= 9 && m <= 11) return "秋";
  return "冬";
};

// 避けたい食材の文字列（「貝、紫蘇、大葉」）を、料理名・材料名と突き合わせる形にする
function avoidKeys(avoidText) {
  return String(avoidText || "")
    .split(/[、,，\/／・\s]+/)
    .map((s) => norm(s))
    .filter((s) => s.length >= 1);
}
const dishHits = (dish, keys) => {
  if (!keys.length) return false;
  const hay = norm(dish.name) + "|" + (dish.ingredients || []).map((i) => norm(i.name)).join("|");
  return keys.some((k) => hay.includes(k));
};

// 条件を1つずつ当てて絞る。緩めるときは後ろの条件から外していく。
function filterDishes(all, c) {
  return all.filter((d) => {
    if (d.role !== "主菜") return false;
    if (c.slot && !(d.slots || "").includes(SLOT_CHAR[c.slot] || "")) return false;
    if (c.excludeNames && c.excludeNames.has(d.name)) return false;
    if (c.avoid && c.avoid.length && dishHits(d, c.avoid)) return false;
    if (c.noFry && d.method === "揚げる") return false;
    if (c.quick && !(d.time <= 20 || (d.equipment || []).includes("電子レンジ"))) return false;
    if (c.kid && !d.kid_friendly) return false;
    if (c.mild && d.spicy) return false;
    if (c.leftover && !d.leftover_ok) return false;
    if (c.fewDishes && (d.equipment || []).length > 1) return false; // 洗い物少なめ＝器具1つで作れる
    if (c.cheap && d.cost === "高め") return false;
    if (c.staples && c.staples.length && d.staple !== "どれでも" && !c.staples.includes(d.staple)) return false;
    if (c.maxMinutes && d.time > c.maxMinutes) return false;
    // 夕食の主菜は、卵だけ・豆腐だけのような軽い一皿にしない
    if (c.substantial && d.heaviness === "軽い") return false;
    if (c.season && d.season !== "通年" && d.season !== c.season) return false;
    if (c.mains && !c.mains.includes(d.main)) return false;
    return true;
  });
}

/**
 * 主菜の候補を返す。
 * opts: { slot, date, maxMinutes, staples[], avoidText, noFry, quick, mainHint, excludeNames[] }
 * 返り値: { dishes: [...], relaxed: "緩めた条件の説明"|"" }
 */
export function pickMainCandidates(opts = {}) {
  const base = {
    slot: opts.slot,
    maxMinutes: Number(opts.maxMinutes) || 0,
    staples: (opts.staples || []).map((v) => STAPLE_JA[v]).filter(Boolean),
    avoid: avoidKeys(opts.avoidText),
    noFry: !!opts.noFry,
    quick: !!opts.quick,
    kid: (opts.style || []).includes("子どもも食べやすい"),
    mild: (opts.style || []).includes("辛いものなし"),
    leftover: (opts.style || []).includes("作り置きしたい"),
    fewDishes: (opts.style || []).includes("洗い物少なめ"),
    cheap: (opts.style || []).includes("節約したい"),
    substantial: opts.slot === "夕食",
    season: seasonOf(opts.date),
    mains: mainsFor(opts.mainHint),
    excludeNames: new Set(opts.excludeNames || []),
  };

  // 緩める順番。ユーザーとの約束（時間・主食・避けたい食材）は最後まで外さない。
  // 気づかれにくいものから順に外す。
  // 主材料（mains）だけは外さない。プロンプト側で「主材料は必ず◯◯」と伝えているので、
  // ここで外すと候補リストと指示が食い違ってしまう。足りなければ候補なしにする。
  const ladder = [
    ["", base],
    ["季節", { ...base, season: null }],
    ["最近作った料理の除外", { ...base, season: null, excludeNames: new Set() }],
    // 「洗い物少なめ」「節約」は好みの度合いなので、行き詰まったらここも外す
    ["洗い物・費用", { ...base, season: null, excludeNames: new Set(), fewDishes: false, cheap: false }],
    ["食べごたえ", { ...base, season: null, excludeNames: new Set(), fewDishes: false, cheap: false, substantial: false }],
  ];
  // 主材料を指定された日は候補が1グループに絞られるので、少なくても許容する
  const minWanted = base.mains ? 5 : MIN_CANDIDATES;

  let picked = [], relaxed = "";
  for (const [label, cond] of ladder) {
    picked = filterDishes(DISHES, cond);
    relaxed = label;
    if (picked.length >= minWanted) break;
  }
  // それでも足りなければ候補を出さない（＝いつも通りAIに自由に作らせる）
  if (picked.length < 3) return { dishes: [], relaxed: "候補なし" };
  const seed = seedOf(`${opts.date}|${opts.slot}|${opts.mainHint || ""}`);
  return { dishes: spread(picked, MAX_CANDIDATES, seed), relaxed, total: picked.length };
}

// プロンプトに載せる1行（名前＋主材料＋時間。材料まで載せると長くなりすぎる）
export const candidateLine = (d) => `${d.name}（${d.main}・${d.time}分・${d.genre}）`;

export const catalogSize = () => DISHES.length;

// ---------- 具材の選択（味噌汁・スープ） ----------
// 味噌汁は具を変えれば何度出しても飽きないので、料理を増やす代わりに
// ユーザーが具材を選べるようにする。魚の種類を選べるのと同じ考え方。
const CHOICE_SETS = DOC.choice_sets || {};
const BY_NAME = new Map(DISHES.map((d) => [d.name, d]));

// できあがった料理に、具材を選べる情報を付ける（カタログに印がある料理だけ）
// カタログの印が最優先。AIは「わかめと豆腐のみそ汁」のようにカタログと違う名前を
// 付けてくるので、名前の末尾でも拾う（味噌汁とスープは具材が入れ替わるものなので）。
function choiceKeyOf(name) {
  const hit = BY_NAME.get(name)?.choice;
  if (hit) return hit;
  if (/(味噌汁|みそ汁|みそしる)$/.test(name)) return "味噌汁の具";
  if (/スープ$/.test(name)) return "スープの具";
  return null;
}

export function attachChoice(dish) {
  if (!dish || !dish.name) return dish;
  const key = choiceKeyOf(dish.name);
  const set = key && CHOICE_SETS[key];
  if (!set) return dish;
  // いま入っている具材（材料名が選択肢と一致するもの）を覚えておき、
  // 選び直したときにこれだけを差し替える
  const names = new Set((dish.ingredients || []).map((i) => norm(i.name)));
  dish.choice = {
    key,
    label: set.label,
    max: set.max || 2,
    options: set.options,
    current: set.options.filter((o) => names.has(norm(o.name))).map((o) => o.name),
  };
  return dish;
}
export const choiceSets = () => CHOICE_SETS;
