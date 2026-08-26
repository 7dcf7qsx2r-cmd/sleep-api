import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function src(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

const CLOUD_DOMAINS = ['garden_seeds', 'sleep_atlas', 'consult_summaries'];

test('SYNC_DOMAINS includes garden seeds, atlas and consult summaries', () => {
  const blob = src('src/services/dataBlob.ts');
  for (const domain of CLOUD_DOMAINS) {
    assert.ok(blob.includes(`'${domain}'`), `dataBlob missing ${domain}`);
  }
});

test('unknown energy claimType is rejected instead of earning 0', () => {
  const ledger = src('src/services/energyLedger.ts');
  const route = src('src/routes/energy.ts');
  assert.ok(ledger.includes('throw new Error(`invalid_claim_type:${claimType}`)'));
  assert.ok(route.includes("error: 'invalid_claim_type'"));
  assert.ok(route.includes('400'));
});

test('garden and squad claim types stay on the energy whitelist', () => {
  const ledger = src('src/services/energyLedger.ts');
  for (const claimType of ['dream_garden_visit', 'dream_garden_harvest', 'squad_share_v2']) {
    assert.ok(ledger.includes(`'${claimType}'`), `missing claim type ${claimType}`);
  }
});

test('garden day boundary uses Shanghai calendar', () => {
  const garden = src('src/services/garden.ts');
  assert.ok(garden.includes("from '../utils/civilDate.js'"));
  assert.match(garden, /function todayStr\(\): string \{\s*return shanghaiToday\(\);/);
});

test('energy account default is 0 not 500', () => {
  const migrate = src('src/db/migrate.ts');
  assert.ok(migrate.includes('ALTER TABLE energy_accounts ALTER COLUMN balance SET DEFAULT 0'));
  assert.ok(migrate.includes('ALTER TABLE energy_accounts ALTER COLUMN total_earned SET DEFAULT 0'));
});

test('users.merged_into_user_id exists for phone merge', () => {
  const migrate = src('src/db/migrate.ts');
  assert.ok(migrate.includes('merged_into_user_id UUID'));
});

test('production rsync keeps host uploads', () => {
  for (const file of [
    '.github/workflows/deploy-production.yml',
    '.github/workflows/deploy-uat.yml',
  ]) {
    assert.ok(src(file).includes('--exclude uploads'), `${file} must exclude uploads`);
  }
  assert.ok(src('scripts/ci/deploy-remote.sh').includes('mkdir -p uploads'));
});

test('ai routes expose chat-with-tools and persist dream images', () => {
  const ai = src('src/routes/ai.ts');
  assert.ok(ai.includes("'/chat-with-tools'"));
  assert.ok(ai.includes('persistRemoteImage'));
  assert.ok(ai.includes('parseChatToolCalls'));
});
