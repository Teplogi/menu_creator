// 栄養の「ひとことコメント」を作る。
//
// AIは使わずルールで判定する。理由は3つ:
//  1. 同じ献立なら毎回同じことを言う（週ごとに言うことがブレると信用されない）
//  2. AIの回数・費用を使わない
//  3. 健康に関わる内容なので、何をどう判定しているかを人が確認できる形にしておく
//
// しきい値は 1日あたりの目安（食塩: 男性7.5g未満・女性6.5g未満／
// エネルギー: 30〜49歳で男性2350-3150kcal・女性1750-2350kcal）を土台にしている。
// 性別・年齢は持っていないので、個人判定はせず「多め／少なめ」の気づきにとどめる。
import { brothRatioOf } from "./catalog.js";

// 判定に使うしきい値。あとから調整しやすいよう1か所にまとめる。
export const THRESHOLDS = {
  // 塩分は2段階にする。目安を超えたら「やや多め」、はっきり超えたら「多め」。
  // 目安ちょうどで強く警告すると、日本の食事はほぼ毎回鳴ってしまい意味が薄れる。
  saltOver: 7.5,      // 1日の目安（男性）。これを超えたら「やや多め」
  saltHigh: 10.0,     // 日本人の平均くらい。これを超えたら「多め」
  saltDayHigh: 12.0,  // 単日でこれ以上なら、その日を名指しする
  soupDaysRatio: 0.7, // 汁物がこの割合以上の日に出ていたら「続いている」
  fiberLow: 14,       // 食物繊維（1日g）
  proteinLow: 50,     // たんぱく質（1日g）
  fatRatioHigh: 35,   // 脂質のエネルギー比（%）
  kcalLow: 1400,      // 1日平均がこれ未満なら少なめ
  kcalHigh: 3200,     // これを超えたら多め
  maxItems: 2,        // 一度に出すコメントは2件まで（多いと説教くさくなる）
};

// 煮汁・漬け汁を残す料理は、材料を全部食べる計算だと塩分が高く出る。
// 表示する数字は変えず、判定のときだけ実際に口に入るぶんに寄せる。
function adjustedSalt(day) {
  let salt = 0;
  for (const m of day.meals || []) for (const d of m.dishes || []) salt += (d.salt || 0) * brothRatioOf(d.name);
  return Math.round(salt * 100) / 100;
}

const mdLabel = (s) => `${Number(String(s).slice(5, 7))}/${Number(String(s).slice(8, 10))}`;
const round1 = (n) => Math.round(n * 10) / 10;

// 献立は「作る」と決めた食事だけを持っている（夕食だけ、という人が多い）。
// それを1日ぶんの目安と比べると、いつでも「少なすぎる」と出てしまう。
// 作っている食事が1日のどれくらいを占めるかを出して、目安のほうを縮める。
const SLOT_SHARE = { 朝食: 0.25, 昼食: 0.35, 夕食: 0.4 };
function coverageOf(days) {
  let sum = 0;
  for (const d of days) {
    let s = 0;
    for (const m of d.meals || []) if ((m.dishes || []).length) s += SLOT_SHARE[m.slot] ?? 0.35;
    sum += Math.min(1, s);
  }
  return Math.max(0.2, Math.min(1, sum / Math.max(1, days.length)));
}
const coverLabel = (c) => (c >= 0.95 ? "1日" : "作った献立ぶん");

/**
 * analyzePlan() の結果からコメントを作る。
 * 返り値: { saltAdjusted, items: [{ kind, level, title, body }] }
 *   level: "warn"（気にかけてほしい） / "info"（軽い気づき） / "good"（よい状態）
 */
export function buildAdvice(n) {
  const days = n?.days || [];
  if (!days.length) return { saltAdjusted: 0, items: [] };
  const a = n.average || {};
  const nd = days.length;

  const saltAdj = days.reduce((s, d) => s + adjustedSalt(d), 0) / nd;
  const cover = coverageOf(days);      // 1日のうち、この献立が占める割合
  const T = (v) => v * cover;          // 目安もその割合ぶんに縮めて比べる
  const unit = coverLabel(cover);
  const found = [];

  // ---- 塩分 ----
  if (saltAdj >= T(THRESHOLDS.saltOver)) {
    const high = saltAdj >= T(THRESHOLDS.saltHigh);
    const worst = days.map((d) => ({ date: d.date, salt: adjustedSalt(d) })).sort((x, y) => y.salt - x.salt)[0];
    const src = topSaltDishes(days, 2);
    found.push({
      kind: "salt", level: high ? "warn" : "info", weight: high ? 100 : 90,
      title: `${nd === 1 ? "この日" : "この期間"}は塩分が${high ? "多め" : "やや多め"}です`,
      body: (cover >= 0.95
          ? `1日あたり約${round1(saltAdj)}g（目安は男性7.5g・女性6.5g未満）。`
          : `作った献立ぶんで1日あたり約${round1(saltAdj)}g（この献立ぶんの目安は約${round1(T(7.5))}g）。`)
        + (src.length ? `${src.join("・")}あたりが効いています。` : "")
        + (worst && worst.salt >= THRESHOLDS.saltDayHigh && nd > 1 ? `とくに${mdLabel(worst.date)}が高めでした。` : ""),
      tips: [
        "汁物は1日1回までにするか、汁を半分残す",
        "しょうゆは「かける」より「小皿につける」",
        "酢・レモン・しょうが・ごま・青じそで、塩を足さずに味を立てる",
      ],
    });
  }

  // ---- 汁物が続いている ----
  const soupDays = days.filter((d) => (d.meals || []).some((m) => (m.dishes || []).some((x) => x.role === "汁物"))).length;
  if (nd >= 3 && soupDays / nd >= THRESHOLDS.soupDaysRatio && saltAdj >= T(THRESHOLDS.saltOver)) {
    found.push({
      kind: "soup", level: "info", weight: 70,
      title: `汁物が${soupDays}日続いています`,
      body: "1〜2日をサラダや和え物に替えると、塩分がぐっと下がります。",
      tips: [
        "汁物を出す日は、主菜の味付けを薄めにする",
        "味噌を1割減らして、だしを濃いめにとる",
        "具だくさんにすると、同じ塩分でも満足しやすい",
      ],
    });
  }

  // ---- 野菜（食物繊維） ----
  if ((a.fiber || 0) < T(THRESHOLDS.fiberLow)) {
    found.push({
      kind: "fiber", level: "info", weight: 80,
      title: "野菜が少なめです",
      body: `食物繊維が${unit}で約${round1(a.fiber || 0)}g。`,
      tips: [
        "作成画面の「品数」で副菜をもう1品増やす",
        "汁物の具に、きのこ・わかめ・根菜を足す",
        "同じ野菜が続かないよう、色の違うものを混ぜる",
      ],
    });
  }

  // ---- たんぱく質 ----
  if ((a.p || 0) < T(THRESHOLDS.proteinLow)) {
    found.push({
      kind: "protein", level: "info", weight: 60,
      title: "たんぱく質が控えめです",
      body: `${unit}で約${round1(a.p || 0)}g。`,
      tips: [
        "卵・豆腐・納豆を副菜に足す（手間をかけずに増やせます）",
        "汁物を豚汁やけんちん汁のような具だくさんにする",
      ],
    });
  }

  // ---- 脂質に寄っている ----
  if ((a.pfc?.f || 0) > THRESHOLDS.fatRatioHigh) {
    found.push({
      kind: "fat", level: "info", weight: 50,
      title: "揚げ物・炒め物が続いています",
      body: `脂質がエネルギーの${a.pfc.f}%を占めています。`,
      tips: [
        "こだわりの「揚げ物なし」を選ぶと、揚げ物を外して作れます",
        "焼く・蒸す・煮るの日を挟む",
        "炒め物の油を大さじ1から小さじ1に減らす",
      ],
    });
  }

  // ---- カロリー ----
  if ((a.kcal || 0) < T(THRESHOLDS.kcalLow)) {
    found.push({
      kind: "kcal", level: "info", weight: 40,
      title: "1日のカロリーが少なめです",
      body: `${unit}で約${a.kcal}kcal。ご飯やパンを材料に入れていない献立は低く出るので、実際はもう少し多いはずです。`,
      tips: ["気になるときは、主食のぶん（ご飯1杯で約230kcal）を足して考えてください"],
    });
  } else if ((a.kcal || 0) > T(THRESHOLDS.kcalHigh)) {
    found.push({
      kind: "kcal", level: "info", weight: 40,
      title: "1日のカロリーが多めです",
      body: `${unit}で約${a.kcal}kcal（1日の目安は男性2,350〜3,150 / 女性1,750〜2,350kcal）。`,
    });
  }

  // ---- 何も引っかからなければ褒める ----
  if (!found.length) {
    return {
      saltAdjusted: round1(saltAdj),
      coverage: Math.round(cover * 100) / 100,
      items: [{
        kind: "good", level: "good",
        title: nd === 1 ? "バランスのよい1日です" : `バランスのよい${nd}日間です`,
        body: `塩分は${unit}で約${round1(saltAdj)}g。野菜もたんぱく質も足りています。この調子で大丈夫です。`,
      }],
    };
  }

  found.sort((x, y) => y.weight - x.weight);
  return {
    saltAdjusted: round1(saltAdj),
    coverage: Math.round(cover * 100) / 100,
    items: found.slice(0, THRESHOLDS.maxItems).map(({ weight, ...rest }) => rest),
  };
}

// 塩分に効いている料理を上位から拾う（補正後で見る）
function topSaltDishes(days, limit) {
  const byName = new Map();
  for (const d of days) for (const m of d.meals || []) for (const x of m.dishes || []) {
    const s = (x.salt || 0) * brothRatioOf(x.name);
    if (s < 1.2) continue; // 塩分がそもそも小さい料理は原因として挙げない
    byName.set(x.name, (byName.get(x.name) || 0) + s);
  }
  return [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([n]) => `「${n}」`);
}
