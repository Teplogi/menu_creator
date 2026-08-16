// 野菜の使い回し。1週間ぶん作ると野菜が23種類に散らばり、その半分以上が
// 「1回だけ使って端数が余る」状態になる。そこで週の初めに使い回す野菜を数種類決め、
// 各食事の副菜か汁物のどちらかで使わせる。
//
// 考え方:
//   主菜の主材料（肉・魚・卵豆腐）は今まで通り散らす ＝ 献立の印象を決めるのはここ
//   副菜・汁物の野菜は繰り返してよい          ＝ 買い物の無駄が出るのはここ
//   同じ野菜でも調理法・料理名は変える        ＝ 繰り返しに気づかせない
//
// 枠を2つに分けている:
//   定番枠   … にんじん・玉ねぎ等。外しても献立からは消えないので、毎週入れて使い切らせる
//   日替わり枠 … キャベツ・大根等。1回で使い切れないサイズで売られていて、いちばん余る
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

let CACHE = null;
function load() {
  if (CACHE) return CACHE;
  let items = {};
  try {
    items = JSON.parse(fs.readFileSync(path.join(DIR, "data/produce.json"), "utf8")).items || {};
  } catch { items = {}; }
  // 表記ゆれ → 代表名
  const byAlias = new Map();
  for (const [name, v] of Object.entries(items)) {
    byAlias.set(name, name);
    for (const a of v.alias || []) byAlias.set(a, name);
  }
  CACHE = { items, byAlias };
  return CACHE;
}
// 「人参」「ニンジン」→「にんじん」。知らない食材は null
export function canonVeg(name) {
  const { byAlias } = load();
  return byAlias.get(String(name || "").trim()) || null;
}
export const produceInfo = (name) => load().items[canonVeg(name) || ""] || null;

// 既定の定番枠。世帯で設定していないときはこれを使う。
export function defaultStaples() {
  const { items } = load();
  return Object.entries(items).filter(([, v]) => v.slot === "定番").map(([n]) => n);
}

// 使い回す野菜の数。食事が多いほど増やす（1週間=7食で4種類）。
export function reuseCount(meals) {
  if (meals < 3) return 0; // 2食以下は使い回す余地がない
  return Math.max(2, Math.min(6, Math.round(meals / 2)));
}

// 「1回でどれだけ使うか」＝ 1品あたりの使用量 ÷ 売り単位。
// もやし1袋・トマト1個・ごぼう1本のように1回で使い切るものは、使い回しても
// 端数が減らない（枠を1つ潰すだけ）ので対象から外す。
// 売り単位（produce.json の unit）を直せば、この判定もそのまま追従する。
const GRAMS = (s) => { const m = String(s || "").match(/(\d+(?:\.\d+)?)\s*g/); return m ? Number(m[1]) : null; };
const USED_UP = 0.7; // 1回で7割以上使うなら「使い切る」とみなす
function usageRatio(catalog) {
  const { items } = load();
  const per = new Map();
  for (const d of catalog) {
    for (const i of d.ingredients || []) {
      const c = canonVeg(i.name);
      const w = GRAMS(i.amount);
      if (c && w) (per.get(c) || per.set(c, []).get(c)).push(w);
    }
  }
  const out = new Map();
  for (const [n, ws] of per) {
    const unit = GRAMS(items[n]?.unit);
    if (!unit || ws.length < 3) continue; // 品数が少なすぎると中央値が当てにならない
    ws.sort((a, b) => a - b);
    out.set(n, ws[Math.floor(ws.length / 2)] / unit);
  }
  return out;
}

// カタログから「その野菜を使う副菜・汁物が何品あるか」を数える。
// 作れる料理が少ない野菜を選ぶと、同じ料理の繰り返しになってしまうため。
function dishCounts(catalog) {
  const n = new Map();
  for (const d of catalog) {
    if (d.role === "主菜") continue;
    const seen = new Set();
    for (const i of d.ingredients || []) {
      const c = canonVeg(i.name);
      if (c && !seen.has(c)) { seen.add(c); n.set(c, (n.get(c) || 0) + 1); }
    }
  }
  return n;
}

/**
 * その週に使い回す野菜を決める。
 * opts: {
 *   meals            食事の数
 *   catalog          献立カタログ（副菜・汁物の作れる数を数えるのに使う）
 *   seed             同じ条件で毎回同じ結果になるようにする種（日付など）
 *   fridge           冷蔵庫にある食材名（最優先で入れる）
 *   avoid            使わない食材名（除外）
 *   soft             控えめにする食材名（選びにくくする）
 *   staples          世帯が設定した定番枠（空なら既定）
 *   recent           直近に使い回した野菜名（除外はせず、選ばれにくくするだけ）
 * }
 * 返り値: [{ name, keep, unit, slot }]
 */
export function pickWeekVeggies(opts = {}) {
  const { items } = load();
  const meals = Number(opts.meals) || 0;
  const total = reuseCount(meals);
  if (!total) return [];

  const counts = dishCounts(opts.catalog || []);
  const ratio = usageRatio(opts.catalog || []);
  const norm = (arr) => new Set((arr || []).map((x) => canonVeg(x)).filter(Boolean));
  const avoid = norm(opts.avoid);
  const soft = norm(opts.soft);
  const recent = norm(opts.recent);
  const fridge = [...norm(opts.fridge)];
  const custom = (opts.staples || []).map((x) => canonVeg(x)).filter(Boolean);
  const stapleSet = new Set(custom.length ? custom : defaultStaples());

  const rnd = mulberry32(hash(String(opts.seed || "")));
  const scored = (names) => names
    .filter((n) => items[n] && !avoid.has(n))
    .map((n) => {
      const dishes = counts.get(n) || 0;
      // 料理数は「足りているか」を見るだけにして（4品もあれば週2〜3回は回せる）、
      // 残りはゆらぎに任せる。ここを料理数で決めると毎週同じ野菜になってしまう。
      let s = Math.min(dishes, 8) * 0.4 + rnd() * 6;
      if (recent.has(n)) s *= 0.55; // 先週も選んだものは選ばれにくく（除外はしない）
      if (soft.has(n)) s *= 0.4;    // 控えめにしたい食材
      return { name: n, dishes, s };
    })
    // 週に2〜3回まわすので、作れる副菜・汁物が3品は要る。
    // 1回で使い切る野菜（もやし・トマト・ごぼう等）は使い回しても端数が減らないので外す。
    .filter((x) => x.dishes >= 3 && (ratio.get(x.name) ?? 0) < USED_UP)
    .sort((a, b) => b.s - a.s);

  const out = [];
  const take = (x) => { if (x && !out.some((o) => o.name === x.name)) out.push(x); };

  // 1. 冷蔵庫にあるものを最優先（使い切り機能と噛み合わせる）
  for (const f of fridge) {
    if (out.length >= total) break;
    if (!items[f] || avoid.has(f) || items[f].slot === "対象外") continue;
    take({ name: f, dishes: counts.get(f) || 0 });
  }
  // 2. 定番枠から（上限2。増える分は日替わり枠に回す）
  const stapleQuota = Math.min(2, Math.max(1, total - 1));
  for (const x of scored([...stapleSet])) {
    if (out.filter((o) => stapleSet.has(o.name)).length >= stapleQuota) break;
    if (out.length >= total) break;
    take(x);
  }
  // 3. 残りは日替わり枠から
  const rotate = Object.keys(items).filter((n) => items[n].slot === "日替わり" && !stapleSet.has(n));
  for (const x of scored(rotate)) {
    if (out.length >= total) break;
    take(x);
  }
  // 4. それでも足りなければ枠を問わず埋める
  for (const x of scored(Object.keys(items).filter((n) => items[n].slot !== "対象外"))) {
    if (out.length >= total) break;
    take(x);
  }
  return out.map((x) => ({
    name: x.name,
    keep: items[x.name]?.keep ?? 7,
    unit: items[x.name]?.unit || "",
    slot: items[x.name]?.slot || "日替わり",
  }));
}

/**
 * 各食事に、その日使う野菜を1つ割り当てる。
 * 日持ちしない野菜は近い日にまとめ（買った翌日・翌々日で使い切る）、
 * 日持ちするものは週全体に散らす。
 * units: [{date, slot}]（日付順である必要はない）
 * 返り値: units と同じ並びの野菜名の配列（割り当てなしは ""）
 */
export function assignVeggies(units, veggies) {
  const out = new Array(units.length).fill("");
  if (!veggies.length || !units.length) return out;

  // 日付ごとにまとめる（1日に2食あっても、その日は同じ野菜でよい）
  const dates = [...new Set(units.map((u) => u.date))].sort();
  const short = veggies.filter((v) => v.keep <= 4);  // 日持ちしない＝固める
  const long = veggies.filter((v) => v.keep > 4);    // 日持ちする＝散らす

  const perDate = new Map();
  let di = 0;
  // 日持ちしないものを先頭の連続した日に置く（買ってすぐ使い切る）
  for (const v of short) {
    const n = Math.min(2, dates.length - di); // 連続2日で使い切る
    for (let k = 0; k < n; k++) perDate.set(dates[di++], v.name);
    if (di >= dates.length) break;
  }
  // 残りの日に、日持ちするものを順番に回す
  const pool = long.length ? long : veggies;
  for (let k = 0; di < dates.length; di++, k++) perDate.set(dates[di], pool[k % pool.length].name);

  units.forEach((u, i) => { out[i] = perDate.get(u.date) || ""; });
  return out;
}

// 使い回しの対象にしない食材（薬味・きのこ・海藻など）。
// これらまで縛ると献立が窮屈になるうえ、少量使いなので端数も出にくい。
export const vegFree = "にんにく・しょうが・ねぎ・大葉などの薬味、きのこ類、海藻、豆腐・厚揚げ・油揚げ";

// 生成プロンプトに入れる指示。
// 「1品でも入っていればOK」だと効果がほとんど出ない（実測 −1.6品）。
// 副菜は使う野菜をセット内に収めさせるのが決定的（同 −3.9品）。
// 汁物はセット内だけだと作れるものが7品しかなく1週間で尽きるので、1種類だけ緩める。
export function vegDirective(veggies, todayVeg) {
  if (!veggies || !veggies.length) return "";
  const names = veggies.map((v) => v.name).join("・");
  return [
    `★今週の野菜（買い物を減らすため、複数の日で使い回します）: ${names}`,
    todayVeg ? `- この食事では、副菜か汁物のどちらかで「${todayVeg}」を主役に使うこと。` : "",
    `- 副菜・汁物の野菜は、できるだけ上の中から選ぶこと。他の野菜を足すなら1食につき1種類までにする。`,
    `- ${vegFree} は自由に使ってよい（使い回しの対象外）。`,
    `- ただし料理は一般家庭の定番であること。指定の野菜に無理に寄せて、`
      + `聞き慣れない一品（例:「長ねぎのナムル」「玉ねぎの酢和え」）を作らないこと。`
      + `定番にならないときは、その野菜は汁物の具にするか、他の野菜を1種類足してよい。`,
    `- 同じ野菜が週に何度も出ます。料理名・調理法・味付けは毎回変えること（例: きんぴら / 味噌汁 / サラダ / 煮物）。`,
    `- 主菜はこの制限を受けない（主菜の食材は今まで通り自由）。`,
  ].filter(Boolean).join("\n");
}

// 指示が守られたかの点検。守れていない食事をログに出して精度を測るために使う。
export function checkVegCompliance(dishes, veggies) {
  const set = new Set((veggies || []).map((v) => v.name));
  if (!set.size) return { ok: true, extra: [] };
  const extra = new Set();
  for (const d of dishes || []) {
    if (d.role === "主菜") continue;
    for (const i of d.ingredients || []) {
      const c = canonVeg(i.name);
      if (!c || set.has(c)) continue;
      if (produceInfo(c)?.slot === "対象外") continue; // 薬味などは自由
      extra.add(c);
    }
  }
  return { ok: extra.size === 0, extra: [...extra] };
}

// 同じ条件なら毎回同じ結果になるようにするための、小さな乱数
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
