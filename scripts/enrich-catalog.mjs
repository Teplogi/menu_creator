// 料理カタログ（data/dish-catalog.json）に材料と属性を書き足す一度きりのスクリプト。
//
//   node scripts/enrich-catalog.mjs            # 未処理の料理だけ処理する（再開できる）
//   node scripts/enrich-catalog.mjs --only 20  # お試しで20品だけ
//   node scripts/enrich-catalog.mjs --force    # すでに入っているものも作り直す
//
// 生成した内容は「下書き」。人の目で確認して直す前提。
// バッチごとにファイルへ書き戻すので、途中で止めてもやり直しが効く。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(DIR, "data/dish-catalog.json");
// 一度作れば固定資産として使い続けるデータなので、生成は品質重視のモデルで行う。
const MODEL = process.env.CATALOG_MODEL || "claude-sonnet-5";
const BATCH = 8;      // 1回のリクエストで扱う料理数
const PARALLEL = 4;   // 同時に投げるリクエスト数
const BASE_PEOPLE = 2; // 材料は2人分で持つ（人数が違うときは後で換算する）

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const ONLY = Number(args[args.indexOf("--only") + 1]) || 0;

const CATEGORIES = ["野菜・果物", "肉・魚", "卵・乳・豆腐", "主食・乾物", "調味料", "その他"];

const DISH_ENRICHMENT = {
  type: "object",
  properties: {
    name: { type: "string", description: "対象の料理名（渡されたものをそのまま返す）" },
    ingredients: {
      type: "array",
      description: `${BASE_PEOPLE}人分の材料。調味料も省略せず全部入れる。`,
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "食材名" },
          amount: { type: "string", description: "分量" },
          category: { type: "string", enum: CATEGORIES },
        },
        required: ["name", "amount", "category"],
        additionalProperties: false,
      },
    },
    heaviness: {
      type: "string",
      enum: ["軽い", "普通", "しっかり"],
      description:
        "一皿としての食べごたえ。軽い=これだけでは夕食の主菜にならない(プレーンオムレツ・冷奴・具の少ない汁物など)、" +
        "普通=主菜として成立するが軽め、しっかり=これが主菜なら満足できる(唐揚げ・ハンバーグ・麻婆豆腐など)。",
    },
    kid_friendly: { type: "boolean", description: "小さい子どもでも食べやすいか（辛さ・クセ・骨などが無い）" },
    spicy: { type: "boolean", description: "辛いか（豆板醤・キムチ・カレー粉・唐辛子などがしっかり効く）" },
    equipment: {
      type: "array",
      description: "主に使う調理器具。当てはまるものだけ。",
      items: { type: "string", enum: ["フライパン", "鍋", "オーブン・トースター", "電子レンジ", "炊飯器", "包丁のみ"] },
    },
    leftover_ok: { type: "boolean", description: "作り置き・翌日のお弁当に回しやすいか" },
    cost: { type: "string", enum: ["安い", "普通", "高め"], description: "材料費の感覚（2人分で 安い=300円台まで / 普通=〜700円 / 高め=それ以上）" },
  },
  required: ["name", "ingredients", "heaviness", "kid_friendly", "spicy", "equipment", "leftover_ok", "cost"],
  additionalProperties: false,
};

const TOOL = {
  name: "save_dishes",
  description: "渡された料理それぞれの材料と属性を返す",
  input_schema: {
    type: "object",
    properties: { dishes: { type: "array", items: DISH_ENRICHMENT } },
    required: ["dishes"],
    additionalProperties: false,
  },
};

// アプリ本体の生成プロンプトと同じ表記ルール。ここがズレると買い物リストが揃わない。
const RULES = [
  "あなたは日本の家庭料理に詳しい管理栄養士です。渡された料理について、一般家庭で作る標準的なレシピの材料と属性を答えてください。",
  "",
  `【材料のルール（重要）】材料は${BASE_PEOPLE}人分で書く。`,
  "- 野菜・果物・豆腐など個数で数えられる食材は「1/2個(100g)」のように 個数(目安の重量g) の形式。単位は 個・本・枚・袋・束・株・丁・かけ など食材に合った自然なもの。数は 1/4・1/3・1/2・1・2 のようなきれいな整数か分数にする。野菜に「120g」のようなgだけの表記は使わない。",
  "- 肉・魚は「200g」「2切れ(160g)」のように重量を基本にする。",
  "- 調味料は「大さじ1」「小さじ1/2」「少々」。水は「200ml」のように書き、category は 調味料 にする。",
  "- にんにく・しょうがは必ず「かけ」で書く（「1かけ(5g)」「1かけ(15g)」）。「片」「小さじ」は使わない。",
  "- 食材名はひらがな・カタカナ・漢字を混ぜない。○ にんにく / にんじん / しょうが / 玉ねぎ / じゃがいも / ねぎ / 長ねぎ / きゅうり / なす / かぼちゃ / だいこん / はくさい　× ニンニク / 人参 / 生姜 / タマネギ / ジャガイモ / 大根 / 白菜。",
  "- 食材名に切り方や下処理（みじん切り・薄切り・下ゆで など）を書かない。名前は食材そのものだけにする。",
  "- 魚の種類を特定しない料理名（焼き魚・魚の照り焼き・白身魚のムニエル など）は、材料も「魚の切り身」と書く。",
  "- 調味料も省略しない。醤油・塩・こしょう・油まで含めて、その料理を作るのに必要なものを全部書く。",
  "",
  "【属性のルール】",
  "- heaviness は「夕食の主菜としてこれ1品で満足できるか」で判断する。副菜・汁物は基本 軽い か 普通。",
  "- equipment は主に使うものだけ（1〜2個）。火を使わない和え物などは「包丁のみ」。",
  "- 迷ったら、一般家庭でいちばんよく作られる作り方を基準にする。",
].join("\n");

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function runBatch(client, dishes) {
  const list = dishes
    .map((d, i) => `${i + 1}. ${d.name}（${d.role} / 主材料:${d.main} / ${d.genre} / ${d.method} / 目安${d.time}分）`)
    .join("\n");
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "save_dishes" },
    messages: [{ role: "user", content: `${RULES}\n\n【対象の料理（この${dishes.length}品ちょうどを、この順で返す）】\n${list}` }],
  });
  const block = res.content.find((c) => c.type === "tool_use");
  if (!block) throw new Error("tool_use が返ってこなかった");
  const got = block.input.dishes || [];
  if (got.length !== dishes.length) throw new Error(`件数が合わない: ${got.length} != ${dishes.length}`);
  return got;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY が設定されていません（.env）");
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const all = doc.dishes;
  let todo = all.filter((d) => FORCE || !d.ingredients);
  if (ONLY) todo = todo.slice(0, ONLY);
  console.log(`カタログ ${all.length}品 / 今回の対象 ${todo.length}品 / モデル ${MODEL}`);
  if (!todo.length) return;

  const client = new Anthropic();
  const byName = new Map(all.map((d) => [d.name, d]));
  const batches = chunk(todo, BATCH);
  let done = 0, failed = 0;

  const save = () => {
    doc.base_people = BASE_PEOPLE;
    fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + "\n", "utf8");
  };

  let cursor = 0;
  const workers = Array.from({ length: Math.min(PARALLEL, batches.length) }, async () => {
    while (cursor < batches.length) {
      const b = batches[cursor++];
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const got = await runBatch(client, b);
          got.forEach((g, i) => {
            // 名前が返ってこない/ズレることがあるので、渡した順を正とする
            const target = byName.get(b[i].name) || byName.get(g.name);
            if (!target) return;
            const { name, ...rest } = g;
            Object.assign(target, rest);
          });
          done += b.length;
          save();
          console.log(`  ${done}/${todo.length} 完了 … ${b.map((x) => x.name).join("、")}`);
          break;
        } catch (e) {
          if (attempt === 3) { failed += b.length; console.error(`  × 失敗 (${b.map((x) => x.name).join("、")}): ${e.message}`); }
          else await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
    }
  });
  await Promise.all(workers);
  save();
  console.log(`\n完了: ${done}品 / 失敗: ${failed}品`);
  console.log("→ node scripts/check-catalog.mjs で内容を点検してください");
}

main().catch((e) => { console.error(e); process.exit(1); });
