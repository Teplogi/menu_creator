// 使わない食材（アレルギー・苦手）の照合。
// 利用者は「甲殻類」「エビ」「海老」のように書くが、料理側は「エビチリ」「桜えび」「かにかま」と書く。
// 文字列の部分一致だけだと「甲殻類」がどの料理にも当たらず、除外が効かなかった。
// そこで、アレルギーの呼び方を品目にまとめ、品目ごとに料理・材料に出てくる書き方を持っておく。
//
// 語の書き方:
//   "えび"            部分一致（料理名・説明・材料名のどこかに含まれる）
//   "=かき"           材料名・料理名と完全一致のときだけ（「かき混ぜる」「かき揚げ」と区別する）
// except は、照合の前に取り除く語（「焼きそば」はそばアレルギーの対象ではない、など）
// 表記だけ揃える（カタカナ→ひらがな・全角英数→半角）。
// 栄養計算用の norm は「お好み」「みじん切り」などを消すので、ここでは使わない
// （「お好み焼き」が「焼き」になり、照り焼きまで小麦に当たってしまう）。
// 括弧の中も消さない（「えび（むき身）」を見落とさないため）。
const norm = (s) => String(s || "")
  .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
  .replace(/[\s・,、.。/／|｜'"’”`~〜－()（）-]/g, "")
  .toLowerCase();

// 特定原材料（表示義務）8品目を先に並べる。画面の選択肢もこの順。
export const ALLERGENS = [
  { key: "卵", major: true, alias: ["卵", "たまご", "玉子", "鶏卵", "卵製品"],
    terms: ["卵", "たまご", "玉子", "うずら", "マヨネーズ", "マヨ", "目玉焼き", "オムレツ", "オムライス", "親子丼",
      "茶碗蒸し", "天津", "錦糸", "タルタル", "メレンゲ", "ピータン", "カルボナーラ", "スクランブルエッグ", "エッグ"],
    except: ["魚卵"] },
  { key: "乳", major: true, alias: ["乳", "牛乳", "乳製品", "ミルク", "乳成分"],
    terms: ["牛乳", "ミルク", "乳製品", "バター", "チーズ", "クリーム", "ヨーグルト", "練乳", "脱脂粉乳", "ホワイトソース",
      "グラタン", "ドリア", "カルボナーラ", "ラッシー", "ギー", "ホエイ", "マスカルポーネ", "モッツァレラ", "パルメザン", "ラテ"],
    except: ["ココナッツミルク", "ピーナッツバター", "ピーナツバター", "豆乳"] },
  { key: "小麦", major: true, alias: ["小麦", "小麦粉", "グルテン", "麦"],
    terms: ["小麦", "薄力粉", "強力粉", "中力粉", "全粒粉", "パン粉", "パン", "うどん", "そうめん", "ひやむぎ", "パスタ",
      "スパゲッティ", "スパゲティ", "マカロニ", "ペンネ", "ラザニア", "中華麺", "ラーメン", "焼きそば", "ちゃんぽん",
      "冷やし中華", "餃子", "ぎょうざ", "春巻き", "ワンタン", "シュウマイ", "焼売", "小籠包", "天ぷら", "てんぷら",
      "お好み焼き", "たこ焼き", "ホットケーキ", "カレールウ", "カレールー", "シチュールウ", "シチュールー", "ルウ",
      "ホワイトソース", "=麩", "=ふ", "車麩", "グルテン", "クスクス", "トルティーヤ", "=ナン", "ピザ", "トースト",
      "サンドイッチ", "ハンバーガー"],
    except: ["フライパン", "パンプキン", "パンチェッタ", "ピザ用"] },
  { key: "えび", major: true, alias: ["えび", "海老", "蝦", "シュリンプ"],
    terms: ["えび", "海老", "蝦", "シュリンプ", "ロブスター", "オマール", "ブラックタイガー", "XO醤"] },
  { key: "かに", major: true, alias: ["かに", "蟹"],
    terms: ["かに", "蟹", "ずわい", "たらば", "かにかま", "カニカマ"] },
  { key: "そば", major: true, alias: ["そば", "蕎麦", "そば粉"],
    terms: ["そば", "蕎麦"],
    except: ["焼きそば", "やきそば", "焼そば", "中華そば", "沖縄そば", "ソース焼きそば"] },
  { key: "落花生", major: true, alias: ["落花生", "ピーナッツ", "ピーナツ", "南京豆"],
    terms: ["落花生", "ピーナッツ", "ピーナツ", "南京豆"] },
  { key: "くるみ", major: true, alias: ["くるみ", "胡桃", "ウォールナッツ"],
    terms: ["くるみ", "胡桃", "ウォールナッツ"] },

  // 特定原材料に準ずるもの（表示推奨）
  { key: "大豆", alias: ["大豆", "大豆製品"],
    terms: ["大豆", "豆腐", "とうふ", "厚揚げ", "生揚げ", "油揚げ", "納豆", "豆乳", "湯葉", "ゆば", "きな粉", "きなこ",
      "おから", "枝豆", "えだまめ", "がんもどき", "大豆ミート"] },
  { key: "ごま", alias: ["ごま", "胡麻"], terms: ["ごま", "胡麻", "芝麻醤", "タヒニ"] },
  { key: "さば", alias: ["さば", "鯖"], terms: ["さば", "鯖"] },
  { key: "さけ", alias: ["さけ", "鮭", "しゃけ", "サーモン"], terms: ["さけ", "鮭", "しゃけ", "サーモン"] },
  { key: "いか", alias: ["いか", "烏賊"], terms: ["いか", "烏賊", "するめ"], except: ["いかなご", "ドライカレー", "ライカ"] },
  { key: "いくら", alias: ["いくら", "すじこ", "筋子"], terms: ["いくら", "すじこ", "筋子"] },
  { key: "あわび", alias: ["あわび", "鮑"], terms: ["あわび", "鮑"] },
  { key: "牛肉", alias: ["牛肉", "牛", "ビーフ"],
    terms: ["牛", "ビーフ", "合いびき", "合挽", "あいびき", "すき焼き"], except: ["牛乳", "牛蒡"] },
  { key: "豚肉", alias: ["豚肉", "豚", "ポーク"],
    terms: ["豚", "ポーク", "ベーコン", "ハム", "ソーセージ", "ウインナー", "ウィンナー", "チャーシュー", "合いびき",
      "合挽", "あいびき", "とんかつ", "ラード", "パンチェッタ", "サラミ", "チョリソー"] },
  { key: "鶏肉", alias: ["鶏肉", "鶏", "とり肉", "鳥肉", "チキン"],
    terms: ["鶏", "とり肉", "鳥肉", "チキン", "ささみ", "手羽", "焼き鳥", "親子丼"], except: ["鶏卵"] },
  { key: "ゼラチン", alias: ["ゼラチン"], terms: ["ゼラチン"] },
  { key: "キウイ", alias: ["キウイ", "キウイフルーツ"], terms: ["キウイ"] },
  { key: "バナナ", alias: ["バナナ"], terms: ["バナナ"] },
  { key: "もも", alias: ["もも", "桃", "ピーチ"], terms: ["桃", "ピーチ", "=もも"] },
  { key: "りんご", alias: ["りんご", "林檎", "アップル"], terms: ["りんご", "林檎", "アップル"] },
  { key: "オレンジ", alias: ["オレンジ"], terms: ["オレンジ", "マーマレード"] },
  { key: "アーモンド", alias: ["アーモンド"], terms: ["アーモンド"] },
  { key: "カシューナッツ", alias: ["カシューナッツ", "カシュー"], terms: ["カシュー"] },
  { key: "マカダミアナッツ", alias: ["マカダミアナッツ", "マカダミア"], terms: ["マカダミア"] },
  { key: "やまいも", alias: ["やまいも", "山芋", "長芋", "ながいも", "大和芋", "とろろ"],
    terms: ["やまいも", "山芋", "長芋", "ながいも", "大和芋", "とろろ", "自然薯"] },
  { key: "まつたけ", alias: ["まつたけ", "松茸"], terms: ["まつたけ", "松茸"] },
];

// 品目をまとめた呼び方。「甲殻類」と書かれたら えび・かに の両方を除く。
const GROUPS = [
  { key: "甲殻類", alias: ["甲殻類", "甲殻"], members: ["えび", "かに"] },
  { key: "貝類", alias: ["貝類", "貝"], members: [],
    terms: ["貝", "あさり", "しじみ", "はまぐり", "ほたて", "帆立", "牡蠣", "=かき", "カキフライ", "生がき", "ムール",
      "つぶ貝", "さざえ", "ほっき", "オイスターソース"], extra: ["あわび"], except: ["貝割れ", "かいわれ"] },
  { key: "魚", alias: ["魚", "魚類", "さかな", "青魚"], members: ["さば", "さけ", "いくら"],
    terms: ["魚", "切り身", "ぶり", "たら", "あじ", "いわし", "さんま", "まぐろ", "かつお", "鯛", "=たい", "ツナ", "しらす",
      "ちりめん", "じゃこ", "かれい", "かじき", "ほっけ", "うなぎ", "あなご", "白身", "かまぼこ", "ちくわ", "はんぺん",
      "さつま揚げ", "削り節", "煮干し", "明太子", "ナンプラー"], except: ["たらの芽", "アジア", "ブリトー", "ブリオッシュ", "ブリー"] },
  { key: "魚介類", alias: ["魚介類", "魚介", "シーフード", "海鮮"], members: ["甲殻類", "貝類", "魚", "いか"],
    terms: ["たこ", "蛸"], except: ["タコス", "タコライス"] },
  { key: "ナッツ類", alias: ["ナッツ類", "ナッツ", "木の実"], members: ["くるみ", "アーモンド", "カシューナッツ", "マカダミアナッツ", "落花生"],
    terms: ["ナッツ", "ピスタチオ", "ヘーゼルナッツ", "ピーカン"] },
];

const BY_KEY = new Map([...ALLERGENS, ...GROUPS].map((a) => [a.key, a]));
const ALIAS = new Map();
for (const a of [...ALLERGENS, ...GROUPS]) for (const w of a.alias) ALIAS.set(norm(w), a.key);

// 「甲殻類アレルギー」「えび類」のような書き方も拾う
const stripSuffix = (s) => s.replace(/(のアレルギー|アレルギー|あれるぎー|類)$/, "");

// 自由入力（「えび、かに」「甲殻類／そば」）を1語ずつに分ける
export function splitAvoid(list) {
  return (Array.isArray(list) ? list : [list])
    .flatMap((x) => String(x || "").split(/[、,，\/／・\s]+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

function collect(key, seen, out) {
  if (seen.has(key)) return;
  seen.add(key);
  const a = BY_KEY.get(key);
  if (!a) return;
  for (const m of [...(a.members || []), ...(a.extra || [])]) collect(m, seen, out);
  for (const t of a.terms || []) out.terms.push({ t, except: a.except || [], label: key });
}

/**
 * 使わない食材を、照合用とプロンプト用に広げる。
 * 返り値: { terms:[{t, except, label}], words:[文字列], prompt:"甲殻類（えび・かに…）、パクチー", empty }
 */
export function expandAvoid(list) {
  const inputs = splitAvoid(list);
  const out = { terms: [], words: [], prompt: "", empty: !inputs.length };
  const promptParts = [];
  for (const raw of inputs) {
    const n = norm(raw);
    const key = ALIAS.get(n) || ALIAS.get(stripSuffix(n));
    if (!key) {
      out.terms.push({ t: raw, except: [], label: raw });
      promptParts.push(raw);
      continue;
    }
    const sub = { terms: [] };
    collect(key, new Set(), sub);
    out.terms.push(...sub.terms);
    // プロンプトには代表的な書き方を添える（加工品・だし・ソースに入る形も含めて伝える）
    const names = [...new Set(sub.terms.map((x) => x.t.replace(/^=/, "")))].slice(0, 14);
    promptParts.push(`${raw}（${names.join("・")}など。加工品・ソース・だし・トッピングに入るものも含む）`);
  }
  // 同じ語が何度も入らないように
  const seen = new Set();
  out.terms = out.terms.filter((x) => {
    const k = x.t + "|" + x.label;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  out.words = [...new Set(out.terms.map((x) => x.t.replace(/^=/, "")))];
  out.prompt = [...new Set(promptParts)].join("、");
  return out;
}

// 照合。料理名・説明・材料名を見る（作り方は「かき混ぜる」などの誤検知が多いので見ない）。
// 返り値: 当たった品目の名前（例: ["甲殻類"の中の "えび"] → ["えび"]）
export function findAvoidHits(dish, expanded) {
  if (!dish || !expanded || !expanded.terms.length) return [];
  const names = [dish.name, ...(dish.ingredients || []).map((i) => i && i.name)].map((s) => norm(s)).filter(Boolean);
  const hay = [norm(dish.name), norm(dish.description), ...names].join("|");
  const hits = new Set();
  for (const { t, except, label } of expanded.terms) {
    if (t.startsWith("=")) {
      const w = norm(t.slice(1));
      if (w && names.includes(w)) hits.add(label);
      continue;
    }
    const w = norm(t);
    if (!w) continue;
    let h = hay;
    for (const ex of except) h = h.split(norm(ex)).join("|");
    if (h.includes(w)) hits.add(label);
  }
  return [...hits];
}

// 画面の選択肢（特定原材料8品目＋準ずるもの）
export const allergenChoices = () => ({
  major: ALLERGENS.filter((a) => a.major).map((a) => a.key),
  others: ["甲殻類", "貝類", "魚介類", "ナッツ類", ...ALLERGENS.filter((a) => !a.major).map((a) => a.key)],
});
