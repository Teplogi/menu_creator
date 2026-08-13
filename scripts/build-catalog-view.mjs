// 料理カタログを人が読める1枚のHTMLに書き出す。
//
//   node scripts/build-catalog-view.mjs
//   → catalog.html ができるので、ブラウザで開く（ダブルクリックでOK）
//
// JSONのままだと見比べにくいので、検索・絞り込み・並べ替えができる形にする。
// 栄養は書き出し時に nutrition.js で計算して埋め込む（材料と分量の点検用）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePlan } from "../nutrition.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const doc = JSON.parse(fs.readFileSync(path.join(DIR, "data/dish-catalog.json"), "utf8"));
const people = doc.base_people || 2;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const rows = doc.dishes.map((d, i) => {
  const n = analyzePlan({ days: [{ date: "x", meals: [{ slot: "夕食", dishes: [d] }] }] }, people).days[0].meals[0].dishes[0];
  return {
    i, name: d.name, role: d.role, main: d.main, genre: d.genre, method: d.method,
    staple: d.staple, time: d.time, season: d.season, slots: d.slots, buy: !!d.buy,
    heaviness: d.heaviness || "", kid: !!d.kid_friendly, spicy: !!d.spicy,
    equipment: d.equipment || [], leftover: !!d.leftover_ok, cost: d.cost || "",
    ings: (d.ingredients || []).map((x) => ({ n: x.name, a: x.amount, c: x.category })),
    kcal: n.kcal, salt: n.salt, p: n.p, f: n.f, c: n.c, unknown: n.unknown,
  };
});

const uniq = (key) => [...new Set(rows.flatMap((r) => (Array.isArray(r[key]) ? r[key] : [r[key]])).filter(Boolean))];
const FILTERS = [
  { key: "role", label: "種類" }, { key: "main", label: "主材料" }, { key: "genre", label: "ジャンル" },
  { key: "method", label: "調理法" }, { key: "heaviness", label: "食べごたえ" }, { key: "staple", label: "主食" },
  { key: "season", label: "季節" }, { key: "cost", label: "費用" }, { key: "equipment", label: "器具" },
];

const filterHtml = FILTERS.map((f) => `
  <label class="fl"><span>${f.label}</span>
    <select data-key="${f.key}"><option value="">すべて</option>${uniq(f.key).sort().map((v) => `<option>${esc(v)}</option>`).join("")}</select>
  </label>`).join("");

const cards = rows.map((r) => `
<article class="d" data-i="${r.i}"
  data-role="${esc(r.role)}" data-main="${esc(r.main)}" data-genre="${esc(r.genre)}" data-method="${esc(r.method)}"
  data-heaviness="${esc(r.heaviness)}" data-staple="${esc(r.staple)}" data-season="${esc(r.season)}"
  data-cost="${esc(r.cost)}" data-equipment="${esc(r.equipment.join(","))}" data-slots="${esc(r.slots)}"
  data-kid="${r.kid ? 1 : 0}" data-spicy="${r.spicy ? 1 : 0}" data-leftover="${r.leftover ? 1 : 0}"
  data-time="${r.time}" data-kcal="${r.kcal}" data-salt="${r.salt}"
  data-text="${esc((r.name + " " + r.ings.map((x) => x.n).join(" ")).toLowerCase())}">
  <header>
    <h2>${esc(r.name)}</h2>
    <span class="role r-${esc(r.role)}">${esc(r.role)}</span>
  </header>
  <div class="chips">
    <span class="c">${esc(r.main)}</span><span class="c">${esc(r.genre)}</span><span class="c">${esc(r.method)}</span>
    <span class="c t">${r.time}分</span>
    <span class="c h h-${esc(r.heaviness)}">${esc(r.heaviness)}</span>
    <span class="c">${esc(r.slots)}</span>
    ${r.season !== "通年" ? `<span class="c s">${esc(r.season)}</span>` : ""}
    ${r.kid ? '<span class="c g">子どもOK</span>' : ""}
    ${r.spicy ? '<span class="c w">辛い</span>' : ""}
    ${r.leftover ? '<span class="c g">作り置き可</span>' : ""}
    ${r.buy ? '<span class="c">市販でOK</span>' : ""}
    <span class="c">${esc(r.cost)}</span>
    <span class="c">${esc(r.equipment.join("・"))}</span>
  </div>
  <div class="nu">1人分 <b>${r.kcal}</b>kcal ・ 塩分 <b>${r.salt}</b>g ・ P${r.p} F${r.f} C${r.c}${r.unknown ? ` <span class="warn">未照合${r.unknown}</span>` : ""}</div>
  <table class="ing">${r.ings.map((x) => `<tr><td>${esc(x.n)}</td><td class="a">${esc(x.a)}</td></tr>`).join("")}</table>
  <div class="meta">${people}人分 ・ 材料${r.ings.length}件 ・ #${r.i}</div>
</article>`).join("");

const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>料理カタログ（${rows.length}品）— めにゅらく！</title>
<style>
  :root { --orange:#f5831f; --orange-d:#e5761a; --soft:#fdecda; --cream:#fff7f1; --ink:#3b3733;
    --muted:#9b8f82; --line:#f0e7dd; --card:#fff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--cream); color:var(--ink); line-height:1.7;
    font-family:"Hiragino Maru Gothic ProN","Hiragino Sans","Yu Gothic UI",system-ui,sans-serif; }
  header.top { position:sticky; top:0; z-index:5; background:rgba(255,247,241,.96);
    backdrop-filter:blur(6px); border-bottom:1px solid var(--line); padding:12px 16px; }
  h1 { margin:0 0 2px; font-size:1.05rem; }
  .sub { color:var(--muted); font-size:.8rem; margin-bottom:10px; }
  .bar { display:flex; flex-wrap:wrap; gap:8px; align-items:flex-end; }
  input[type=search] { flex:1 1 220px; min-width:180px; padding:9px 12px; border:1.5px solid var(--line);
    border-radius:10px; font:inherit; background:#fff; }
  .fl { display:flex; flex-direction:column; gap:2px; }
  .fl span { font-size:.68rem; color:var(--muted); font-weight:700; }
  select { padding:7px 8px; border:1.5px solid var(--line); border-radius:9px; font:inherit; background:#fff; font-size:.85rem; }
  .toggles { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
  .tg { border:1.5px solid var(--line); background:#fff; border-radius:999px; padding:4px 12px;
    font-size:.78rem; font-weight:700; cursor:pointer; color:var(--muted); }
  .tg.on { background:var(--orange); border-color:var(--orange); color:#fff; }
  .count { font-size:.8rem; color:var(--muted); margin-top:8px; }
  main { padding:16px; display:grid; gap:12px; grid-template-columns:1fr; max-width:1400px; margin:0 auto; }
  @media (min-width:700px) { main { grid-template-columns:repeat(2,1fr); } }
  @media (min-width:1080px) { main { grid-template-columns:repeat(3,1fr); } }
  .d { background:var(--card); border-radius:14px; padding:14px 16px; box-shadow:0 4px 14px rgba(184,142,92,.09); }
  .d header { display:flex; align-items:baseline; gap:8px; }
  .d h2 { margin:0; font-size:1rem; flex:1; }
  .role { font-size:.68rem; font-weight:800; border-radius:999px; padding:2px 9px; background:var(--soft); color:var(--orange-d); }
  .role.r-副菜 { background:#eef3ec; color:#6c8a66; } .role.r-汁物 { background:#eaf1f7; color:#4a7ba5; }
  .chips { display:flex; flex-wrap:wrap; gap:4px; margin:8px 0; }
  .c { font-size:.68rem; border:1px solid var(--line); border-radius:999px; padding:1px 8px; color:var(--muted); }
  .c.t { color:var(--ink); } .c.s { background:#f6efe6; }
  .c.g { background:#eef3ec; color:#6c8a66; border-color:#dfeadb; }
  .c.w { background:#fdeceb; color:#c0564f; border-color:#f6dcd9; }
  .c.h-しっかり { background:var(--soft); color:var(--orange-d); border-color:#f6dcbb; font-weight:700; }
  .c.h-軽い { background:#f1f1f1; }
  .nu { font-size:.75rem; color:var(--muted); border-top:1px dashed var(--line); padding-top:7px; }
  .nu b { color:var(--ink); }
  .warn { color:#c0564f; font-weight:700; }
  table.ing { width:100%; border-collapse:collapse; margin-top:6px; font-size:.82rem; }
  table.ing td { padding:2px 0; border-bottom:1px dotted var(--line); vertical-align:top; }
  table.ing td.a { text-align:right; color:var(--muted); white-space:nowrap; padding-left:10px; }
  .meta { font-size:.68rem; color:var(--muted); margin-top:8px; }
  .none { grid-column:1/-1; text-align:center; color:var(--muted); padding:40px 0; }
</style></head>
<body>
<header class="top">
  <h1>料理カタログ　${rows.length}品</h1>
  <div class="sub">材料は${people}人分。栄養は日本食品標準成分表から計算した1人分の目安です。
    直すときは data/dish-catalog.json を編集して、このファイルを作り直してください。</div>
  <div class="bar">
    <input type="search" id="q" placeholder="料理名・食材で検索（例: 豆腐、ひき肉）">
    ${filterHtml}
    <label class="fl"><span>並べ替え</span>
      <select id="sort"><option value="">カタログ順</option><option value="time">時間が短い順</option>
        <option value="kcal">カロリーが低い順</option><option value="kcal-">カロリーが高い順</option>
        <option value="salt-">塩分が多い順</option><option value="name">名前順</option></select></label>
  </div>
  <div class="toggles">
    <button class="tg" data-flag="kid">子どもOK</button>
    <button class="tg" data-flag="leftover">作り置き可</button>
    <button class="tg" data-flag="spicy">辛い</button>
    <button class="tg" data-slot="夕">夕食に出せる</button>
    <button class="tg" id="reset">条件をクリア</button>
  </div>
  <div class="count" id="count"></div>
</header>
<main id="list">${cards}<p class="none" id="none" style="display:none">条件に合う料理がありません。</p></main>
<script>
  const $ = (s) => document.querySelector(s);
  const cards = [...document.querySelectorAll('.d')];
  const selects = [...document.querySelectorAll('select[data-key]')];
  const flags = new Set(); let slotFilter = '';
  function apply() {
    const q = $('#q').value.trim().toLowerCase();
    let n = 0;
    for (const el of cards) {
      let ok = !q || el.dataset.text.includes(q);
      if (ok) for (const s of selects) {
        if (!s.value) continue;
        const v = el.dataset[s.dataset.key] || '';
        if (s.dataset.key === 'equipment' ? !v.split(',').includes(s.value) : v !== s.value) { ok = false; break; }
      }
      if (ok) for (const f of flags) if (el.dataset[f] !== '1') { ok = false; break; }
      if (ok && slotFilter && !(el.dataset.slots || '').includes(slotFilter)) ok = false;
      el.style.display = ok ? '' : 'none';
      if (ok) n++;
    }
    $('#count').textContent = n + '品を表示中（全' + cards.length + '品）';
    $('#none').style.display = n ? 'none' : 'block';
  }
  function sortList() {
    const v = $('#sort').value;
    const list = $('#list');
    const num = (el, k) => Number(el.dataset[k] || 0);
    const sorted = [...cards].sort((a, b) => {
      if (v === 'time') return num(a,'time') - num(b,'time');
      if (v === 'kcal') return num(a,'kcal') - num(b,'kcal');
      if (v === 'kcal-') return num(b,'kcal') - num(a,'kcal');
      if (v === 'salt-') return num(b,'salt') - num(a,'salt');
      if (v === 'name') return a.querySelector('h2').textContent.localeCompare(b.querySelector('h2').textContent, 'ja');
      return num(a,'i') - num(b,'i');
    });
    sorted.forEach((el) => list.appendChild(el));
    list.appendChild($('#none'));
  }
  $('#q').addEventListener('input', apply);
  selects.forEach((s) => s.addEventListener('change', apply));
  $('#sort').addEventListener('change', sortList);
  document.querySelectorAll('.tg[data-flag]').forEach((b) =>
    b.addEventListener('click', () => { const f = b.dataset.flag;
      if (flags.has(f)) { flags.delete(f); b.classList.remove('on'); } else { flags.add(f); b.classList.add('on'); }
      apply(); }));
  document.querySelectorAll('.tg[data-slot]').forEach((b) =>
    b.addEventListener('click', () => { const on = slotFilter === b.dataset.slot;
      slotFilter = on ? '' : b.dataset.slot; b.classList.toggle('on', !on); apply(); }));
  $('#reset').addEventListener('click', () => {
    $('#q').value = ''; selects.forEach((s) => s.value = ''); $('#sort').value = '';
    flags.clear(); slotFilter = '';
    document.querySelectorAll('.tg').forEach((b) => b.classList.remove('on'));
    sortList(); apply();
  });
  apply();
</script>
</body></html>`;

const out = path.join(DIR, "catalog.html");
fs.writeFileSync(out, html, "utf8");
console.log(`catalog.html を書き出しました（${rows.length}品 / ${Math.round(html.length / 1024)}KB）`);
console.log(`→ ${out} をブラウザで開いてください`);
