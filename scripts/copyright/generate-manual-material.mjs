#!/usr/bin/env node
/** 设计说明书 → 可打印 HTML（前 30 页 + 后 30 页） */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const MD = path.join(ROOT, 'docs/copyright/设计说明书-V1.0.0.md');
const OUT = path.join(ROOT, 'docs/copyright/设计说明书-V1.0.0.html');
const META = { name: '小眠 AI 睡眠健康服务后台软件', version: 'V1.0.0', company: '广州爱霖生命科学有限公司' };
const TARGET_PAGES = 30;

function inlineFormat(text) {
  return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function mdToSections(md) {
  const sections = [];
  let cur = { title: '', blocks: [] };
  for (const line of md.split('\n')) {
    if (line.startsWith('# ')) continue;
    if (line.startsWith('## ')) {
      if (cur.title || cur.blocks.length) sections.push(cur);
      cur = { title: line.slice(3).trim(), blocks: [] };
    } else if (line.startsWith('### ')) {
      cur.blocks.push({ type: 'h3', text: line.slice(4).trim() });
    } else if (line.startsWith('- ')) {
      const last = cur.blocks.at(-1);
      if (last?.type === 'ul') last.items.push(line.slice(2));
      else cur.blocks.push({ type: 'ul', items: [line.slice(2)] });
    } else if (line.trim() && !line.startsWith('|') && line.trim() !== '---') {
      cur.blocks.push({ type: 'p', text: line.trim() });
    }
  }
  if (cur.title || cur.blocks.length) sections.push(cur);
  return sections;
}

function splitSectionIntoPages(section) {
  const pages = [];
  let current = { chapter: section.title, title: '', blocks: [] };
  for (const block of section.blocks) {
    if (block.type === 'h3') {
      if (current.title || current.blocks.length) pages.push(current);
      current = { chapter: section.title, title: block.text, blocks: [] };
    } else {
      current.blocks.push(block);
    }
  }
  if (current.title || current.blocks.length) pages.push(current);
  return pages;
}

function renderBlock(b) {
  if (b.type === 'h3') return `<h3>${inlineFormat(b.text)}</h3>`;
  if (b.type === 'ul') return `<ul>${b.items.map((i) => `<li>${inlineFormat(i)}</li>`).join('')}</ul>`;
  return `<p>${inlineFormat(b.text)}</p>`;
}

function pageHtml(page, n, tag) {
  const header = `${META.name} ${META.version}　　${tag}　　第 ${n} 页`;
  const h2 = page.chapter ? `<h2>${inlineFormat(page.chapter)}</h2>` : '';
  const h3 = page.title ? `<h3>${inlineFormat(page.title)}</h3>` : '';
  return `<section class="page"><div class="header">${header}</div><div class="body">${h2}${h3}${page.blocks.map(renderBlock).join('')}</div></section>`;
}

const sections = mdToSections(fs.readFileSync(MD, 'utf8'));
const allPages = sections.flatMap(splitSectionIntoPages);
if (allPages.length < TARGET_PAGES * 2) {
  console.error(`文档仅 ${allPages.length} 页，不足 ${TARGET_PAGES * 2} 页`);
  process.exit(1);
}
const first = allPages.slice(0, TARGET_PAGES);
const last = allPages.slice(-TARGET_PAGES);

let html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/><title>${META.name} 设计说明书</title>
<style>@page{size:A4;margin:20mm 18mm}body{font-family:SimSun,serif;font-size:11pt;line-height:1.75;margin:0}.page{page-break-after:always;min-height:250mm}.header{text-align:center;font-family:SimHei,sans-serif;font-size:10pt;font-weight:bold;border-bottom:1px solid #000;padding-bottom:2mm;margin-bottom:8mm}.body h2{font-size:14pt;font-family:SimHei;margin:0 0 4mm}.body h3{font-size:12pt;font-family:SimHei;margin:4mm 0 3mm}.body p{text-indent:2em;margin:0 0 3mm}.body ul{margin:0 0 4mm 1.5em}.cover{page-break-after:always;text-align:center;padding-top:60mm;font-family:SimHei}.cover h1{font-size:22pt}</style></head><body>
<div class="cover"><h1>${META.name}</h1><p>设计说明书 ${META.version}</p><p>${META.company}</p></div>`;
first.forEach((s, i) => { html += pageHtml(s, i + 1, '设计说明书'); });
html += `<div class="cover"><h1>${META.name}</h1><p>设计说明书</p><p>（续）</p></div>`;
last.forEach((s, i) => { html += pageHtml(s, i + 1, '设计说明书'); });
html += '</body></html>';
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log('设计说明书 HTML:', OUT);
console.log(`正文 ${allPages.length} 页，已导出前 ${TARGET_PAGES} + 后 ${TARGET_PAGES} 页`);
