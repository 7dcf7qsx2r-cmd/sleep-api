#!/usr/bin/env node
/**
 * 软著鉴别材料 · sleep-api 源程序前 30 页 + 后 30 页
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeCopyrightLine, sanitizeCopyrightPath } from './sanitize-source-line.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.join(ROOT, 'docs/copyright');

const CONFIG = {
  softwareName: '小眠 AI 睡眠健康服务后台软件',
  version: 'V1.0.0',
  linesPerPage: 50,
  pageCount: 30,
  extensions: ['.ts'],
  sourceDirs: ['src'],
  rootFiles: [],
  priorityFiles: [
    'src/index.ts',
    'src/app.ts',
    'src/routes/auth.ts',
    'src/routes/radar.ts',
    'src/routes/sync.ts',
    'src/services/auth.ts',
    'src/services/radar.ts',
    'src/db/migrate.ts',
    'src/middleware/auth.ts',
    'src/routes/admin/index.ts',
    'src/routes/admin/auth.ts',
    'src/db/client.ts',
  ],
  tailPriorityFiles: [
    'src/services/energy.ts',
    'src/services/energyLedger.ts',
    'src/services/quota.ts',
    'src/services/shop.ts',
    'src/services/wechat.ts',
  ],
  excludeFiles: [
    'src/routes/ai.ts',
    'src/lib/deepseek.ts',
    'src/lib/siliconflowTts.ts',
    'src/lib/siliconflowStt.ts',
    'src/lib/siliconflowImage.ts',
  ],
  excludeDirs: ['node_modules', 'dist', 'data'],
};

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    if (CONFIG.excludeDirs.includes(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (CONFIG.extensions.includes(path.extname(name))) acc.push(full);
  }
  return acc;
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function isExcluded(filePath) {
  return CONFIG.excludeFiles.includes(rel(filePath));
}

function collectFiles() {
  const all = new Set();
  for (const d of CONFIG.sourceDirs) walk(path.join(ROOT, d), []).forEach((f) => all.add(f));

  const ordered = [];
  const seen = new Set();
  const push = (filePath) => {
    if (!filePath || seen.has(filePath) || isExcluded(filePath)) return;
    ordered.push(filePath);
    seen.add(filePath);
  };

  for (const p of CONFIG.priorityFiles) {
    const full = path.join(ROOT, p);
    if (fs.existsSync(full)) push(full);
  }
  for (const f of [...all].sort((a, b) => rel(a).localeCompare(rel(b)))) push(f);

  const tail = [];
  for (const p of CONFIG.tailPriorityFiles) {
    const full = path.join(ROOT, p);
    if (!fs.existsSync(full) || isExcluded(full)) continue;
    const idx = ordered.indexOf(full);
    if (idx >= 0) ordered.splice(idx, 1);
    tail.push(full);
    seen.add(full);
  }
  ordered.push(...tail);
  return ordered;
}

function buildLineStream(files) {
  const lines = [];
  for (const file of files) {
    lines.push(`/* --- ${sanitizeCopyrightPath(rel(file))} --- */`);
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      lines.push(sanitizeCopyrightLine(line));
    }
  }
  return lines;
}

function chunkPages(allLines) {
  const pages = [];
  for (let i = 0; i < allLines.length; i += CONFIG.linesPerPage) {
    pages.push(allLines.slice(i, i + CONFIG.linesPerPage));
  }
  return pages;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderPage(pageLines, pageNo, section) {
  const header = `${CONFIG.softwareName} ${CONFIG.version}　　${section}　　第 ${pageNo} 页`;
  const body = pageLines
    .map((line, i) => `<tr><td class="ln">${String(i + 1).padStart(3, ' ')}</td><td class="code"><pre>${escapeHtml(line)}</pre></td></tr>`)
    .join('\n');
  const pad = CONFIG.linesPerPage - pageLines.length;
  let extra = '';
  for (let i = 0; i < pad; i++) extra += `<tr><td class="ln"></td><td class="code"></td></tr>\n`;
  return `<section class="page"><div class="header">${escapeHtml(header)}</div><table class="src"><tbody>${body}${extra}</tbody></table></section>`;
}

function main() {
  const files = collectFiles();
  const allLines = buildLineStream(files);
  const pages = chunkPages(allLines);
  const need = CONFIG.pageCount;
  const first = pages.slice(0, need);
  const last = pages.slice(-need);

  let html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>${CONFIG.softwareName} 源程序鉴别材料</title>
<style>
  @page { size: A4; margin: 18mm 15mm; }
  body { font-family: "Courier New", "SimSun", monospace; font-size: 9pt; margin: 0; }
  .page { page-break-after: always; min-height: 260mm; }
  .header { text-align: center; font-family: "SimHei", sans-serif; font-size: 10pt; font-weight: bold; margin-bottom: 6mm; border-bottom: 1px solid #000; padding-bottom: 2mm; }
  table.src { width: 100%; border-collapse: collapse; }
  td.ln { width: 8mm; color: #666; vertical-align: top; text-align: right; padding-right: 2mm; }
  td.code pre { margin: 0; white-space: pre-wrap; word-break: break-all; font-size: 8.5pt; line-height: 1.35; }
  .cover { page-break-after: always; padding: 40mm 20mm; font-family: "SimHei", sans-serif; }
  .cover h1 { font-size: 18pt; text-align: center; }
</style></head><body>
<div class="cover"><h1>${CONFIG.softwareName}</h1>
<p>版本号：${CONFIG.version}</p>
<p>源程序鉴别材料（前 ${need} 页 + 后 ${need} 页）</p>
<p>源文件：${files.length} 个 · 约 ${allLines.length} 行</p>
<p>著作权人：广州爱霖生命科学有限公司</p></div>`;

  first.forEach((p, i) => { html += renderPage(p, i + 1, '源程序前30页'); });
  html += `<div class="cover"><h1>${CONFIG.softwareName}</h1><p>源程序 · 后 ${need} 页</p></div>`;
  last.forEach((p, i) => { html += renderPage(p, i + 1, '源程序后30页'); });
  html += '</body></html>';

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'source-material.html');
  fs.writeFileSync(outPath, html, 'utf8');
  fs.writeFileSync(
    path.join(OUT_DIR, 'source-manifest.json'),
    JSON.stringify(
      {
        softwareName: CONFIG.softwareName,
        version: CONFIG.version,
        fileCount: files.length,
        totalLines: allLines.length,
        totalPages: pages.length,
        excludedFiles: CONFIG.excludeFiles,
        output: rel(outPath),
      },
      null,
      2,
    ),
  );

  console.log(`✅ ${outPath}`);
  console.log(`   ${files.length} 文件, ${allLines.length} 行, 导出 ${first.length}+${last.length} 页`);
}

main();
