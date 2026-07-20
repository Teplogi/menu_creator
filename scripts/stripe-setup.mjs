// Stripe に「めにゅらく！ プレミアム」の商品＋月額料金(Price)を作成し、Price ID を表示する補助スクリプト。
//   使い方（テストモードの秘密鍵を .env に設定した上で）:
//     node scripts/stripe-setup.mjs               # 既定 ¥480/月
//     node scripts/stripe-setup.mjs 680           # ¥680/月 で作成
//   表示された price_xxx を .env の STRIPE_PRICE_ID に貼り付けてください。
//   （何度実行しても新しい Price を作るだけです。金額変更は新Priceを作って差し替える運用）
import "dotenv/config";
import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  console.error("STRIPE_SECRET_KEY が未設定です。.env にテストモードの秘密鍵を設定してください。");
  process.exit(1);
}
const amount = Number(process.argv[2]) || 480; // JPY は最小単位=円（zero-decimal）
if (!Number.isInteger(amount) || amount < 50) {
  console.error("金額（円）は50以上の整数で指定してください。例: node scripts/stripe-setup.mjs 480");
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const product = await stripe.products.create({
  name: "めにゅらく！ プレミアム",
  description: "AI献立の作成・作り直し・1品差し替えが使い放題",
});
const price = await stripe.prices.create({
  product: product.id,
  unit_amount: amount, // JPYは円そのまま
  currency: "jpy",
  recurring: { interval: "month" },
});

console.log("✅ 作成しました");
console.log("  Product:", product.id, `(${product.name})`);
console.log("  Price  :", price.id, `= ¥${amount}/月`);
console.log("");
console.log("次の1行を .env に設定してください:");
console.log(`  STRIPE_PRICE_ID=${price.id}`);
