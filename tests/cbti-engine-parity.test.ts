import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverEngine = join(here, '../src/services/cbti/engine.ts');
const appEngine = join(here, '../../sleep-app-rn/src/data/cbti/engine.ts');

test('服务端规则引擎与 App 逐字一致', { skip: !existsSync(appEngine) && 'sleep-app-rn 不在同级目录' }, () => {
  assert.equal(readFileSync(serverEngine, 'utf8'), readFileSync(appEngine, 'utf8'));
});
