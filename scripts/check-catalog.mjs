// 料理カタログの点検。enrich-catalog.mjs で入れた下書きを人が直す前に、
// 機械的に分かるおかしさ（抜け・表記ゆれ・成分表に無い食材）を洗い出す。
//
//   node scripts/check-catalog.mjs         # 点検するだけ
//   node scripts/check-catalog.mjs --fix   # 機械的に直せるもの（表記ゆれ・切り方）を直す
//
// 「成分表で見つからない食材」が出たら、data/nutrition-map.json に別名を足すか、
// カタログ側の書き方を直す。ここが埋まるほど栄養計算と買い物リストが安定する。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _internals, analyzePlan } from "../nutrition.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const doc = JSON.parse(fs.readFileSync(path.join(DIR, "data/dish-catalog.json"), "utf8"));
const dishes = doc.dishes;
const { findFood, toGrams } = _internals;

const FIX = process.argv.includes("--fix");
const REQUIRED = ["ingredients", "heaviness", "kid_friendly", "spicy", "equipment", "leftover_ok", "cost"];
const UNITS = "g|ml|kg|個|本|枚|袋|束|株|丁|かけ|パック|切れ|尾|房|缶|節|合|杯|膳|箱|皿|玉|腹|カップ";
const G = "(\\(\\d+(?:\\.\\d+)?g\\))?";
const AMOUNT_OK = new RegExp(`^(大さじ|小さじ|カップ)\\s*[\\d/と.]+${G}$|^[\\d/と.]+\\s*(${UNITS})${G}$|^(少々|ひとつまみ|適量|お好みで)$`);
// 同じ食材の書き分けを1つに寄せる（左=出てくるかもしれない表記、右=採用する表記）。
// アプリの生成プロンプトで「○」にしている書き方に合わせている。
const CANON = {
  "たまねぎ": "玉ねぎ", "タマネギ": "玉ねぎ", "玉葱": "玉ねぎ",
  "人参": "にんじん", "ニンジン": "にんじん",
  "ニンニク": "にんにく", "大蒜": "にんにく",
  "生姜": "しょうが", "ショウガ": "しょうが",
  "ジャガイモ": "じゃがいも", "馬鈴薯": "じゃがいも",
  "大根": "だいこん", "ダイコン": "だいこん",
  "白菜": "はくさい", "ハクサイ": "はくさい",
  "葱": "ねぎ", "ネギ": "ねぎ", "長葱": "長ねぎ", "長ネギ": "長ねぎ", "青ネギ": "青ねぎ", "小ネギ": "小ねぎ",
  "キュウリ": "きゅうり", "胡瓜": "きゅうり",
  "ナス": "なす", "茄子": "なす",
  "カボチャ": "かぼちゃ", "南瓜": "かぼちゃ",
  "ホウレンソウ": "ほうれん草", "ほうれんそう": "ほうれん草",
  "コマツナ": "小松菜", "こまつな": "小松菜",
  "シメジ": "しめじ", "エノキ": "えのき", "エノキタケ": "えのき",
  "シイタケ": "しいたけ", "椎茸": "しいたけ", "舞茸": "まいたけ", "マイタケ": "まいたけ",
  "モヤシ": "もやし", "ゴボウ": "ごぼう", "牛蒡": "ごぼう", "レンコン": "れんこん", "蓮根": "れんこん",
  "サツマイモ": "さつまいも", "薩摩芋": "さつまいも", "サトイモ": "さといも", "里芋": "さといも",
  "ニラ": "にら", "韮": "にら", "オクラ": "おくら",
  "たまご": "卵", "タマゴ": "卵", "鶏卵": "卵",
  "醤油": "しょうゆ", "正油": "しょうゆ",
  "味醂": "みりん", "みそ": "味噌",
  "胡麻油": "ごま油", "ゴマ油": "ごま油", "胡椒": "こしょう", "コショウ": "こしょう",
  "オリーブ油": "オリーブオイル", "砂糖": "砂糖", "食塩": "塩",
  "片栗粉": "片栗粉", "小麦粉": "小麦粉",
};
// 食材名に混ざりがちな下ごしらえの言葉。名前は食材そのものだけにしたい。
const PREP_IN_NAME = /(の?みじん切り|の?千切り|の?せん切り|の?薄切り|の?乱切り|の?ざく切り|の?輪切り|の?一口大|下ゆで|下茹で|茹でた|ゆでた|すりおろし|おろし)/g;
// 水・揚げ油など、栄養に影響しないので成分表に当てなくてよいもの
const IGNORE = JSON.parse(fs.readFileSync(path.join(DIR, "data/nutrition-map.json"), "utf8")).ignore || [];
const isIgnored = (n) => IGNORE.some((w) => n === w || n.startsWith(w));
// アプリ側が解釈できる分量の書き方に寄せる
function fixAmount(a) {
  let s = String(a || "").trim()
    .replace(/[（(]\s*(\d+(?:\.\d+)?)\s*[gｇ]\s*[）)]/, "($1g)")   // 括弧を半角に揃える
    .replace(/^(.+?)\s*[（(][^）)0-9][^）)]*[）)]$/, "$1")        // 「200g(薄切り8枚)」→「200g」
    .replace(/(杯|膳|皿|箱|合)分(?=\s*\(|$)/, "$1")               // 「2杯分(400g)」→「2杯(400g)」
    .replace(/^(?:茶碗|お茶碗|どんぶり)\s*/, "")                   // 「茶碗2杯(400g)」→「2杯(400g)」
    .replace(/^少々\((\d+(?:\.\d+)?)g\)$/, "少々");                // 飾りの「少々(5g)」は少々のまま
  // 「3cm(100g)」のように単位が扱えないものは、書いてあるグラムだけ残す
  const m = s.match(/^(.+?)\((\d+(?:\.\d+)?)g\)$/);
  if (m && !new RegExp(`^[\\d/と.]+\\s*(${UNITS})$`).test(m[1]) && !/^(大さじ|小さじ|カップ)/.test(m[1])) s = `${m[2]}g`;
  return s;
}

const missing = [];
const badAmount = [];
const ngName = [];
const unknownFood = new Map();
const prepInName = [];
let ingTotal = 0;

for (const d of dishes) {
  const lack = REQUIRED.filter((k) => d[k] === undefined || (Array.isArray(d[k]) && !d[k].length));
  if (lack.length) { missing.push(`${d.name}: ${lack.join(",")}`); continue; }
  for (const ing of d.ingredients) {
    ingTotal++;
    let nm = (ing.name || "").trim();
    const stripped = nm.replace(PREP_IN_NAME, "").trim();
    if (stripped && stripped !== nm) {
      prepInName.push(`${d.name} / ${nm} → ${stripped}`);
      if (FIX) { nm = stripped; ing.name = nm; }
    }
    if (CANON[nm] && CANON[nm] !== nm) {
      ngName.push(`${d.name} / ${nm} → ${CANON[nm]}`);
      if (FIX) { nm = CANON[nm]; ing.name = nm; }
    }
    if (FIX) ing.amount = fixAmount(ing.amount);
    if (!AMOUNT_OK.test((ing.amount || "").trim())) badAmount.push(`${d.name} / ${nm} / 「${ing.amount}」`);
    if (isIgnored(nm)) continue; // 水・ローリエなど栄養に影響しないものは対象外
    if (!findFood(nm)) unknownFood.set(nm, (unknownFood.get(nm) || 0) + 1);
    else if (!toGrams(ing.amount, nm).grams && !/少々|ひとつまみ|適量|お好み/.test(ing.amount || "")) {
      badAmount.push(`${d.name} / ${nm} / 「${ing.amount}」→ グラムに換算できない`);
    }
  }
}

const show = (title, arr, limit = 25) => {
  console.log(`\n■ ${title}: ${arr.length}件`);
  arr.slice(0, limit).forEach((x) => console.log("   " + x));
  if (arr.length > limit) console.log(`   …ほか ${arr.length - limit}件`);
};

console.log(`カタログ ${dishes.length}品 / 材料のべ ${ingTotal}件 / ${BASELINE()}`);
function BASELINE() { return `${dishes.filter((d) => d.ingredients).length}品に材料あり（${doc.base_people || "?"}人分）`; }

if (FIX) {
  fs.writeFileSync(path.join(DIR, "data/dish-catalog.json"), JSON.stringify(doc, null, 2) + "\n", "utf8");
  console.log(`（--fix: 食材名 ${ngName.length + prepInName.length}件を直して保存しました）`);
}

show("必須項目が足りない料理", missing);
show(FIX ? "直した食材名（表記ゆれ）" : "表記を直したい食材名", ngName);
show(FIX ? "直した食材名（切り方が入っていた）" : "食材名に切り方が入っている", prepInName);
show("分量の書き方が想定外", badAmount);

const unknown = [...unknownFood.entries()].sort((a, b) => b[1] - a[1]);
show("成分表で見つからない食材（別名を足すか名前を直す）", unknown.map(([n, c]) => `${n} ×${c}`), 40);

// 主菜なのに軽い＝夕食に出すと物足りない料理。今回の見直しの主役なので必ず目視する。
const lightMains = dishes.filter((d) => d.role === "主菜" && d.heaviness === "軽い" && (d.slots || "").includes("夕"));
show("「軽い」のに夕食の主菜になっている料理（slots を朝昼に直す候補）", lightMains.map((d) => `${d.name}（${d.main} / ${d.slots}）`), 40);

const byH = {};
for (const d of dishes) if (d.heaviness) byH[`${d.role}/${d.heaviness}`] = (byH[`${d.role}/${d.heaviness}`] || 0) + 1;
console.log("\n■ heaviness の分布:", byH);

// 材料と分量が通しで正しいかは、栄養を計算させてみるのが一番早い。
// 1人分でありえない値になる料理は、材料の量か照合のどこかがおかしい。
const people = doc.base_people || 2;
const odd = [];
for (const d of dishes) {
  const n = analyzePlan({ days: [{ date: "x", meals: [{ slot: "夕食", dishes: [d] }] }] }, people).days[0].meals[0].dishes[0];
  // ポトフのような食べごたえのある汁物は、副菜と同じ物差しでは測れない
  const heavy = d.role === "主菜" || d.heaviness === "しっかり";
  if (n.kcal > (heavy ? 1100 : 600) || n.kcal < (heavy ? 80 : 10) || n.salt > (heavy ? 6 : 4)) {
    odd.push(`${d.name}（${d.role}）: ${n.kcal}kcal / 塩分${n.salt}g${n.unknown ? ` / 不明${n.unknown}件` : ""}`);
  }
}
show(`1人分の栄養がおかしそうな料理（${people}人分の材料から算出）`, odd, 30);
console.log("   ※ 鍋・おでん・味付け卵のように煮汁や漬け汁を残す料理は、材料を全部食べる計算になるので");
console.log("      塩分が実際より高く出る。これはカタログの誤りではなく計算方法の限界。");
