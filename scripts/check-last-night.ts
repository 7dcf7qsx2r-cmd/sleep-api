import 'dotenv/config';
import { query, closeDb } from '../src/db/client.js';
import { sleepNightDate, shanghaiToday, shanghaiHour } from '../src/utils/civilDate.js';

const sn = (process.argv[2] ?? '14639369D06C').toUpperCase();

async function main() {
  const now = new Date();
  console.log(`上海 ${shanghaiToday(now)} ${shanghaiHour(now)}点 · API 默认 nightDate=${sleepNightDate(now)}`);
  const { rows: sessions } = await query(
    `SELECT night_date, duration_minutes, sleep_start, sleep_end, computed_at
       FROM iot_sleep_sessions WHERE sn = $1 ORDER BY night_date DESC LIMIT 5`,
    [sn],
  );
  console.log('\n最近 session:');
  for (const r of sessions) {
    console.log(`  ${String(r.night_date).slice(0, 10)}  ${r.duration_minutes}min  ${r.sleep_start} → ${r.sleep_end}`);
  }
  const { rows: epochs } = await query(
    `SELECT night_date, count(*)::int n FROM iot_sleep_epochs WHERE sn = $1
      GROUP BY night_date ORDER BY night_date DESC LIMIT 5`,
    [sn],
  );
  console.log('\n最近 epoch:');
  for (const r of epochs) console.log(`  ${String(r.night_date).slice(0, 10)}  ${r.n} epochs`);
  const { rows: msg } = await query(
    `SELECT count(*)::int n, min(received_at) min_at, max(received_at) max_at
       FROM iot_messages WHERE sn = $1 AND received_at >= NOW() - INTERVAL '24 hours'`,
    [sn],
  );
  console.log('\n近24h 原始报文:', msg[0]);
  await closeDb();
}
main().catch(async (e) => { console.error(e); await closeDb().catch(() => {}); process.exit(1); });
