// コラム（content/columns/*.md）を、アプリが読める1つのJSONに書き出す。
//
//   npm run columns   → public/columns.json
//
// 記事はMarkdownのテキストで書く。画像にしないのは、文字が検索でき、食材から
// 引けて、あとから直しやすいため。図解だけ画像を貼る想定。
//
// 記事の書き方は content/columns/README.md を参照。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(DIR, "content/columns");
const OUT = path.join(DIR, "public/columns.json");

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// --- 先頭の --- ではさまれた部分（記事の情報）を読む ---
function splitFrontMatter(text) {
  const m = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (/^\[.*\]$/.test(v)) {
      meta[k] = v.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else {
      meta[k] = v.replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body: m[2] };
}

// --- Markdown（使う記法だけ）→ HTML ---
// 外部ライブラリを入れずに済ませる。先にHTMLエスケープしてから記法を戻すので、
// 記事に <script> と書かれても実行されない。
function inline(s) {
  return esc(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}" loading="lazy">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) =>
      /^https?:\/\//.test(href) ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${t}</a>` : `<a href="${href}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function mdToHtml(md) {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let list = null, para = [], quote = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  // 引用（>）は「注意ボックス」として出す。免責や「医師に相談を」に使う想定。
  const flushQuote = () => { if (quote.length) { out.push(`<div class="col-note">${inline(quote.join(" "))}</div>`); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushAll(); continue; }
    let m;
    if ((m = line.match(/^(#{2,4})\s+(.*)$/))) { flushAll(); const n = m[1].length; out.push(`<h${n}>${inline(m[2])}</h${n}>`); continue; }
    if (/^(---|\*\*\*)$/.test(line.trim())) { flushAll(); out.push("<hr>"); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); quote.push(m[1]); continue; }
    flushQuote();
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara();
      if (list !== "ul") { flushList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(m[1])}</li>`); continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (list !== "ol") { flushList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${inline(m[1])}</li>`); continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushAll();
  return out.join("\n");
}

if (!fs.existsSync(SRC)) { console.error(`${SRC} がありません`); process.exit(1); }
const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".md") && f !== "README.md");
const columns = [];
const problems = [];

for (const f of files) {
  const { meta, body } = splitFrontMatter(fs.readFileSync(path.join(SRC, f), "utf8"));
  const slug = meta.slug || f.replace(/\.md$/, "");
  for (const k of ["title", "summary", "author", "date"]) if (!meta[k]) problems.push(`${f}: ${k} がありません`);
  if (meta.draft === "true") { console.log(`  （下書きのため出力しない: ${f}）`); continue; }
  columns.push({
    slug,
    title: meta.title || slug,
    summary: meta.summary || "",
    author: meta.author || "",
    authorTitle: meta.author_title || "",
    date: meta.date || "",
    updated: meta.updated || "",
    hero: meta.hero || "",
    tags: meta.tags || [],
    relatedFoods: meta.related_foods || [],
    html: mdToHtml(body),
  });
}
columns.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // 新しい順

// 食材名 → 記事slug の索引。買い物リストや献立から「この食材のコラム」を出すのに使う。
const byFood = {};
for (const c of columns) for (const f of c.relatedFoods) (byFood[f] = byFood[f] || []).push(c.slug);

fs.writeFileSync(OUT, JSON.stringify({ columns, byFood, builtFrom: files.length }, null, 1) + "\n", "utf8");
console.log(`columns.json を書き出しました（${columns.length}記事 / 食材索引 ${Object.keys(byFood).length}語）`);
if (problems.length) { console.log("\n■ 直したほうがよい点"); problems.forEach((p) => console.log("   " + p)); }
