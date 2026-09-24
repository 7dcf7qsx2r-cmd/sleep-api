import assert from 'node:assert/strict';
import test from 'node:test';
import { productIdConflict } from '../src/routes/admin/productConflict.ts';

test('duplicate product id becomes a clear conflict message', () => {
  const result = productIdConflict({
    code: '23505',
    detail: 'Key (id)=(123) already exists.',
  });
  assert.deepEqual(result, {
    error: 'id_taken',
    message: '商品 ID「123」已经存在，请换一个，或留空让系统自动生成',
  });
});

test('other database errors stay unhandled', () => {
  assert.equal(productIdConflict({ code: '22003', detail: 'numeric field overflow' }), null);
  assert.equal(productIdConflict(new Error('boom')), null);
});
