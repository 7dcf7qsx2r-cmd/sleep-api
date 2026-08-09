/**
 * /ai/tonight-portrait 文案解析冒烟（不打真实 DeepSeek）
 * 运行: npx tsx tests/tonight-portrait-parse.test.ts
 */
import assert from 'node:assert/strict';

function clampPortraitText(s: string, max: number): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseTonightPortraitJson(raw: string) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const p = JSON.parse(match[0]) as {
    title?: string;
    oneLiner?: string;
    careHint?: string;
    echo?: string;
  };
  if (!p.title || !p.oneLiner) return null;
  return {
    title: clampPortraitText(String(p.title), 16),
    oneLiner: clampPortraitText(String(p.oneLiner), 48),
    careHint: clampPortraitText(String(p.careHint || ''), 36),
    echo: clampPortraitText(String(p.echo || ''), 16),
  };
}

const sample = parseTonightPortraitJson(`好的：
{"title":"封口的潮汐","oneLiner":"「未回的消息」还浮在岸边，先不必回。","careHint":"先抽收口的一幕。","echo":"未回的消息"}
`);

assert.equal(sample?.title, '封口的潮汐');
assert.ok((sample?.oneLiner.length ?? 0) > 8);
console.log('  ✓ tonight-portrait JSON parse');
console.log('ok');
