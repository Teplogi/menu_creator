// 監修者の一覧（コラムの「監修」表示と、レシピの「チェック済み」バッジで使う）。
//
// 実名を出さない監修者はペンネーム＋資格で表示する。名前を変えるときはここだけ直せばよい。
// 記事やレシピに監修を付けるのは、**その人が実際に中身を見たものだけ**にすること
// （見ていないものに「監修」と書くと、実際より良く見せる表示＝優良誤認になる）。
// 運営側では、監修の同意書・免許証の写し・チェックした記録を保管しておく。
export const SUPERVISORS = {
  // TODO: 本人とペンネームを決めたら差し替える（いまは仮の名前）
  dietitian: { name: "ひなた", title: "管理栄養士", note: "資格は運営が免許証で確認しています" },
  pharmacist: { name: "新井 鉄平", title: "薬剤師", note: "" },
};

// 記事・レシピに書かれた監修者のキー（dietitian など）→ 表示用の情報。知らないキーは無視する。
export function supervisorOf(key) {
  const s = SUPERVISORS[String(key || "").trim()];
  return s ? { key: String(key).trim(), ...s } : null;
}
