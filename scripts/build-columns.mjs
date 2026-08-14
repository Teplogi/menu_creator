// コラムの点検。書いた記事がちゃんと読めるかを確かめる。
//
//   npm run columns
//
// 記事は保存するだけでアプリに出ます（サーバが起動時に content/columns/*.md を
// 読み込むため）。このスクリプトは書き出しではなく、確認用です。
import { readColumns } from "../columns.js";

const r = readColumns();
console.log(`記事 ${r.columns.length}本（下書き除く／ファイル ${r.files}件）`);
for (const c of r.columns) {
  const marks = [
    c.hero ? "画像" : "",
    c.relatedFoods.length ? `食材${c.relatedFoods.length}` : "",
    c.adviceTags.length ? `栄養:${c.adviceTags.join("/")}` : "",
  ].filter(Boolean).join(" ・ ");
  console.log(`  ${c.date}  ${c.title}  [${c.slug}]${marks ? "  … " + marks : ""}`);
}
console.log(`\n食材からの索引 ${Object.keys(r.byFood).length}語 / 栄養コメントからの索引 ${Object.keys(r.byAdvice).length}件`);
if (r.problems.length) {
  console.log("\n■ 直したほうがよい点");
  r.problems.forEach((p) => console.log("   " + p));
} else {
  console.log("\n問題なし。サーバを再起動（または本番へpush）すれば反映されます。");
}
