/** 只读：用生产 iot_sleep_epochs 跑 computeSleepDepthSeries，核验深度曲线是否合理 */
import 'dotenv/config';
import { listSleepEpochs } from '../src/services/iotSleepEpochs.js';
import { computeSleepDepthSeries } from '../src/services/iotSleepDepth.js';
import { closeDb } from '../src/db/client.js';

const sn = (process.argv[2] ?? '14639369D06C').toUpperCase();
const night = process.argv[3] ?? '2026-09-09';

function shHM(ms: number): string {
  const d = new Date(ms + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

async function main() {
  const rows = await listSleepEpochs(sn, night);
  const series = computeSleepDepthSeries(rows);
  const vals = series.map((s) => s.depth).filter((v): v is number => v != null);
  console.log(`\n设备 ${sn} · 夜 ${night} · epoch ${rows.length} · 有深度 ${vals.length} · null ${series.length - vals.length}`);
  if (vals.length) {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    console.log(`深度 min ${Math.min(...vals)} · max ${Math.max(...vals)} · 均值 ${mean.toFixed(1)}`);
  }
  // 20 分钟桶均值草图
  const buckets = new Map<number, number[]>();
  for (const s of series) {
    if (s.depth == null) continue;
    const b = Math.floor(s.epochStartMs / 1_200_000);
    (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(s.depth);
  }
  console.log('\n时刻   深度均  条形');
  for (const [b, arr] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const m = arr.reduce((a, c) => a + c, 0) / arr.length;
    console.log(`${shHM(b * 1_200_000)}  ${m.toFixed(0).padStart(5)}  ${'█'.repeat(Math.round(m / 4))}`);
  }
  await closeDb();
}
main().catch(async (e) => { console.error(e); await closeDb().catch(() => {}); process.exit(1); });
