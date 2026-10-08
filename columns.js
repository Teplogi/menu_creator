// コラム（content/columns/*.md）の読み込みとMarkdownの変換。
//
// サーバ起動時にここで読み込み、/api/columns で配る。
// ビルド成果物をコミットする形にしていないのは、GitHub上で .md を直すだけで
// 本番に反映されるようにするため（書く人が毎回コマンドを叩かなくてよい）。
//
// 記事の書き方は content/columns/README.md を参照。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supervisorOf } from "./supervisors.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(DIR, "content/columns");

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
    const v = line.slice(i + 1).trim();
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

const isTableRow = (s) => /^\s*\|.*\|\s*$/.test(s);
const isTableSep = (s) => /^\s*\|[\s:|-]+\|\s*$/.test(s) && s.includes("-");
const tableCells = (s) => s.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const BR = "␞"; // 段落を組み立てたあとで <br> に戻すための目印（本文に出ない文字）
// 折り返して書かれた行をつなぐ。日本語どうしのあいだには空白を入れない
// （英文は単語がくっつくので空白を入れる）。
const isAscii = (ch) => ch.charCodeAt(0) < 128;
function joinLines(arr) {
  let s = "";
  for (const line of arr) {
    if (!s) { s = line; continue; }
    const a = s[s.length - 1], b = line[0];
    s += !isAscii(a) && !isAscii(b) ? "" : " ";
    s += line;
  }
  return s;
}

export function mdToHtml(md) {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let list = null, para = [], quote = [];
  const joinPara = (arr) => inline(joinLines(arr)).split(BR).join("<br>");
  const flushPara = () => { if (para.length) { out.push(`<p>${joinPara(para)}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  // 引用（>）は「注意ボックス」として出す。免責や「医師に相談を」に使う想定。
  const flushQuote = () => { if (quote.length) { out.push(`<div class="col-note">${joinPara(quote)}</div>`); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };
  // 行末の半角スペース2つ＝ここで改行（Markdownの決まり）
  const keepBreak = (s) => (/ {2,}$/.test(s) ? s.trim() + BR : s.trim());

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, (t) => (t.includes("\n") ? "" : t)); // 行末スペースは残す
    if (!line.trim()) { flushAll(); continue; }
    // 表（| 見出し | 見出し | の次の行が |---|---| になっているもの）
    if (isTableRow(line) && isTableSep(lines[i + 1] || "")) {
      flushAll();
      const head = tableCells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) rows.push(tableCells(lines[i++]));
      i--;
      out.push(`<table class="col-table"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>`
        + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    let m;
    if ((m = line.match(/^(#{2,4})\s+(.*)$/))) { flushAll(); const n = m[1].length; out.push(`<h${n}>${inline(m[2])}</h${n}>`); continue; }
    if (/^(---|\*\*\*)$/.test(line.trim())) { flushAll(); out.push("<hr>"); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); quote.push(keepBreak(m[1])); continue; }
    flushQuote();
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara();
      if (list !== "ul") { flushList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(m[1].trim())}</li>`); continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (list !== "ol") { flushList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${inline(m[1].trim())}</li>`); continue;
    }
    flushList();
    para.push(keepBreak(line));
  }
  flushAll();
  return out.join("\n");
}

// --- 記事の読み込み ---
export function readColumns() {
  if (!fs.existsSync(SRC)) return { columns: [], byFood: {}, byAdvice: {}, problems: ["content/columns がありません"] };
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".md") && f !== "README.md");
  const columns = [];
  const problems = [];
  for (const f of files) {
    let meta, body;
    try { ({ meta, body } = splitFrontMatter(fs.readFileSync(path.join(SRC, f), "utf8"))); }
    catch (e) { problems.push(`${f}: 読めません（${e.message}）`); continue; }
    const slug = meta.slug || f.replace(/\.md$/, "");
    for (const k of ["title", "summary", "author", "date"]) if (!meta[k]) problems.push(`${f}: ${k} がありません`);
    if (meta.draft === "true") continue; // 下書きは出さない
    // 監修者は supervisors.js のキーで書く（名前を直接書かせないのは、表記ゆれと仮名の差し替え漏れを防ぐため）
    const sup = meta.supervisor ? supervisorOf(meta.supervisor) : null;
    if (meta.supervisor && !sup) problems.push(`${f}: supervisor「${meta.supervisor}」は supervisors.js にありません`);
    columns.push({
      slug,
      title: meta.title || slug,
      summary: meta.summary || "",
      author: meta.author || "",
      authorTitle: meta.author_title || "",
      supervisor: sup ? { name: sup.name, title: sup.title, note: sup.note } : null,
      date: meta.date || "",
      updated: meta.updated || "",
      hero: meta.hero || "",
      tags: meta.tags || [],
      relatedFoods: meta.related_foods || [],
      adviceTags: meta.advice_tags || [],
      html: mdToHtml(body),
    });
  }
  columns.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // 新しい順
  // 食材名 → 記事。買い物リストや献立から「この食材のコラム」を出すのに使う。
  const byFood = {};
  for (const c of columns) for (const f of c.relatedFoods) (byFood[f] = byFood[f] || []).push(c.slug);
  // 栄養コメント（salt / fiber …）→ 記事。「塩分が多め」から対策の記事へ飛ばす。
  const byAdvice = {};
  for (const c of columns) for (const t of c.adviceTags) (byAdvice[t] = byAdvice[t] || []).push(c.slug);
  return { columns, byFood, byAdvice, problems, files: files.length };
}
