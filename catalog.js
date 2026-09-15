// 料理カタログからの候補出し。
// 献立の条件（調理時間・主食・避けたい食材・主材料の割り当てなど）でコードが機械的に絞り、
// 残った候補をAIに渡して「この中から選ぶ」形にする。
// コードで絞る理由は、時間や除外食材のような約束は確実に守りたいから。
// AIに選ばせる理由は、「子どもが食べやすいもの」のような自由入力の要望はタグでは拾えないから。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _internals } from "./nutrition.js";
import { expandAvoid, findAvoidHits } from "./allergens.js";

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
// カタログの main をそのまま渡されることもある（AIなしの組み立てで使う）
const CATALOG_MAINS = ["鶏肉", "豚肉", "牛肉", "ひき肉", "魚介", "卵", "豆腐大豆", "野菜", "その他"];
function mainsFor(hint) {
  const h = String(hint || "").trim();
  if (CATALOG_MAINS.includes(h)) return [h];
  return (MAIN_MAP.find(([re]) => re.test(h)) || [])[1] || null;
}

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

// 避けたい食材の文字列（「甲殻類、紫蘇」）を、料理名・材料名と突き合わせる形にする。
// 「甲殻類」→ えび・かに、「えび」→ 海老・シュリンプ・えびチリ… のように広げる（allergens.js）
const avoidKeys = (avoidText) => expandAvoid(avoidText);
const dishHits = (dish, keys) => !keys.empty && findAvoidHits(dish, keys).length > 0;

// 条件を1つずつ当てて絞る。緩めるときは後ろの条件から外していく。
function filterDishes(all, c) {
  return all.filter((d) => {
    if (d.role !== "主菜") return false;
    if (c.slot && !(d.slots || "").includes(SLOT_CHAR[c.slot] || "")) return false;
    if (c.excludeNames && c.excludeNames.has(d.name)) return false;
    if (c.avoid && dishHits(d, c.avoid)) return false;
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
export const allDishes = () => DISHES; // 野菜の使い回しで「その野菜で作れる料理数」を数えるのに使う

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

// 「食べる汁の割合」。鍋・おでん・漬け込みは煮汁を残すので、
// 材料を全部食べる前提の計算だと塩分が高く出る。その補正に使う。
// カタログにない料理名（AIが作った名前）は、名前から見当をつける。
export function brothRatioOf(name) {
  const hit = BY_NAME.get(name);
  if (hit && typeof hit.broth_ratio === "number") return hit.broth_ratio;
  const n = String(name || "");
  if (/おでん|鍋|しゃぶしゃぶ|すき焼き|水炊き/.test(n)) return 0.4;
  if (/浅漬|ピクルス|マリネ|味付け卵|南蛮漬け|漬け丼/.test(n)) return 0.5;
  if (/(味噌汁|みそ汁|スープ|吸い物|汁)$/.test(n)) return 1;
  if (/煮|煮込み|煮物/.test(n)) return 0.75;
  return 1;
}

// ---------- 分量の人数換算 ----------
// カタログは2人分で持っているので、人数が違うときは掛け算して書き直す。
const BASE_PEOPLE = DOC.base_people || 2;
const FRACTIONS = [[0, ""], [0.25, "1/4"], [1 / 3, "1/3"], [0.5, "1/2"], [2 / 3, "2/3"], [0.75, "3/4"], [1, ""]];
function fmtCount(n) {
  if (n >= 10) return String(Math.round(n));
  const whole = Math.floor(n + 1e-9);
  const frac = n - whole;
  let best = FRACTIONS[0], bestD = Infinity;
  for (const f of FRACTIONS) { const d = Math.abs(frac - f[0]); if (d < bestD) { bestD = d; best = f; } }
  let w = whole + (best[0] === 1 ? 1 : 0);
  let s = best[0] === 1 ? "" : best[1];
  if (!s && w === 0 && n > 0.01) s = "1/4"; // 0に消えるのを防ぐ
  if (!s) return String(w);
  return w ? `${w}と${s}` : s;
}
const fmtGram = (g) => (g >= 100 ? Math.round(g / 10) * 10 : g >= 20 ? Math.round(g / 5) * 5 : Math.round(g));
const AMT_UNITS = "個|本|枚|袋|束|株|丁|かけ|片|パック|切れ|尾|房|玉|缶|節|合|杯|膳|箱|皿|腹";

export function scaleAmount(amount, ratio) {
  const t = String(amount || "").trim();
  if (!t || ratio === 1) return t;
  if (/^(少々|ひとつまみ|適量|お好みで)$/.test(t)) return t; // 目分量は変えない
  let m = t.match(new RegExp(`^(大さじ|小さじ|カップ)\\s*(${NUMRE})$`));
  if (m) { const n = parseNumJa(m[2]) * ratio; return isNaN(n) ? t : `${m[1]}${fmtCount(n)}`; }
  m = t.match(new RegExp(`^(${NUMRE})\\s*(${AMT_UNITS})(?:\\((\\d+(?:\\.\\d+)?)g\\))?$`));
  if (m) {
    const n = parseNumJa(m[1]) * ratio;
    if (isNaN(n)) return t;
    return `${fmtCount(n)}${m[2]}${m[3] ? `(${fmtGram(parseFloat(m[3]) * ratio)}g)` : ""}`;
  }
  m = t.match(new RegExp(`^(${NUMRE})\\s*(g|ml|kg|l)$`, "i"));
  if (m) { const n = parseNumJa(m[1]) * ratio; return isNaN(n) ? t : `${fmtGram(n)}${m[2]}`; }
  return t;
}
const NUMRE = "\\d+(?:\\.\\d+)?と\\d+\\s*/\\s*\\d+|\\d+\\s*/\\s*\\d+|\\d+(?:\\.\\d+)?";
function parseNumJa(s) {
  const t = String(s || "").trim();
  let m = t.match(/^(\d+(?:\.\d+)?)と(\d+)\s*\/\s*(\d+)$/);
  if (m) return parseFloat(m[1]) + Number(m[2]) / Number(m[3]);
  m = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]);
  m = t.match(/^(\d+(?:\.\d+)?)$/);
  return m ? parseFloat(m[1]) : NaN;
}

// ---------- AIを使わない即時生成 ----------
// カタログには材料が入っているので、作り方が要らないときはAIなしで献立を組める。
// 待ち時間ゼロ・無料枠も減らない。自由入力の要望は反映できないので、そこは画面側で伝える。
const MAIN_ROTATION_KEYS = ["鶏肉", "魚介", "豚肉", "ひき肉", "鶏肉", "魚介", "牛肉", "豚肉", "豆腐大豆", "卵"];

function sideCandidates(all, c) {
  return all.filter((d) => {
    if (d.role !== c.role) return false;
    if (c.slot && !(d.slots || "").includes(SLOT_CHAR[c.slot] || "")) return false;
    if (c.excludeNames.has(d.name)) return false;
    if (c.avoid && dishHits(d, c.avoid)) return false;
    if (c.noFry && d.method === "揚げる") return false;
    if (c.kid && !d.kid_friendly) return false;
    if (c.mild && d.spicy) return false;
    if (c.leftover && !d.leftover_ok) return false;
    if (c.cheap && d.cost === "高め") return false;
    if (c.season && d.season !== "通年" && d.season !== c.season) return false;
    if (c.avoidMain && d.main === c.avoidMain) return false; // 主菜と主材料が被らないように
    return true;
  });
}

/**
 * カタログだけで献立を組み立てる（AIを呼ばない）。
 * units: [{date, slot}] / opts: 生成条件（people, maxCookMinutes, staple, dishCount, guided, avoid）
 */
export function buildPlanFromCatalog(units, opts = {}) {
  const people = Math.max(1, Number(opts.people) || BASE_PEOPLE);
  const ratio = people / BASE_PEOPLE;
  const style = opts.guided?.style || [];
  const common = {
    avoid: avoidKeys([opts.avoid, ...(opts.storeAvoid || [])].filter(Boolean).join("、")),
    noFry: (opts.guided?.cooking || []).includes("揚げ物なし"),
    kid: style.includes("子どもも食べやすい"),
    mild: style.includes("辛いものなし"),
    leftover: style.includes("作り置きしたい"),
    cheap: style.includes("節約したい"),
  };
  const dc = String(opts.dishCount || "main_side");
  const sideCount = dc.includes("side2") ? 2 : dc.includes("side") ? 1 : 0;
  const wantSoup = dc.includes("soup");
  const used = new Set(opts.recentNames || []); // 同じ献立の中と直近履歴で重複させない

  const byDate = new Map();
  units.forEach((u, i) => {
    const seed = seedOf(`${u.date}|${u.slot}`);
    // 主菜: 主材料を順番に回して、同じ食材が続かないようにする
    const wantMain = MAIN_ROTATION_KEYS[i % MAIN_ROTATION_KEYS.length];
    const dishes = [];
    const mainArgs = (hint, exclude) => ({
      slot: u.slot, date: u.date, maxMinutes: opts.maxCookMinutes, staples: opts.staple,
      avoidText: [opts.avoid, ...(opts.storeAvoid || [])].filter(Boolean).join("、"),
      noFry: common.noFry, quick: (opts.guided?.cooking || []).includes("レンジ・時短中心"),
      style, mainHint: hint, excludeNames: exclude,
    });
    // 主菜が見つからないまま食事を作ってしまわないよう、段階的に条件を外す
    let mainPick = pickOne(pickMainCandidates(mainArgs(wantMain, [...used])).dishes, used);
    if (!mainPick) mainPick = pickOne(pickMainCandidates(mainArgs("", [...used])).dishes, used);
    if (!mainPick) mainPick = pickOne(pickMainCandidates(mainArgs("", [])).dishes, used);
    if (mainPick) dishes.push(toDish(mainPick, ratio));

    const sideCond = { ...common, role: "副菜", slot: u.slot, season: seasonOf(u.date), excludeNames: used, avoidMain: mainPick?.main };
    for (let k = 0; k < sideCount; k++) {
      const p = pickOne(spread(sideCandidates(DISHES, sideCond), 12, seed + k), used);
      if (p) dishes.push(toDish(p, ratio));
    }
    if (wantSoup) {
      const p = pickOne(spread(sideCandidates(DISHES, { ...sideCond, role: "汁物", avoidMain: null }), 12, seed), used);
      if (p) dishes.push(toDish(p, ratio));
    }
    if (!byDate.has(u.date)) byDate.set(u.date, { date: u.date, meals: [] });
    byDate.get(u.date).meals.push({ slot: u.slot, dishes });
  });
  return { days: [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)) };
}

function pickOne(list, used) {
  const hit = list.find((d) => !used.has(d.name)) || list[0];
  if (hit) used.add(hit.name);
  return hit || null;
}
function toDish(d, ratio) {
  const dish = {
    role: d.role,
    name: d.name,
    description: "",
    cook_minutes: d.time,
    ingredients: (d.ingredients || []).map((i) => ({ ...i, amount: scaleAmount(i.amount, ratio) })),
    steps: [],
  };
  if (d.role === "主菜") dish.main_type = MAIN_TYPE_OF[d.main] || "野菜";
  return attachChoice(dish);
}
const MAIN_TYPE_OF = {
  鶏肉: "肉", 豚肉: "肉", 牛肉: "肉", ひき肉: "肉", 魚介: "魚",
  卵: "卵・豆腐", 豆腐大豆: "卵・豆腐", 野菜: "野菜", その他: "野菜",
};
