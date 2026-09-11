import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  buildAppPayParams,
  buildSignedContent,
  isPaidTradeStatus,
  signRsa2,
  toOrderString,
  verifyAlipayNotify,
  verifyRsa2,
} from '../src/lib/alipay.js';

const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

test('RSA2 sign and verify round-trip', () => {
  const content = 'app_id=2021006174696085&method=alipay.trade.app.pay';
  const sign = signRsa2(content, pair.privateKey);
  assert.equal(verifyRsa2(content, sign, pair.publicKey), true);
  assert.equal(verifyRsa2(`${content}&tamper=1`, sign, pair.publicKey), false);
});

test('notify verify drops sign fields and empty values', () => {
  const payload = {
    app_id: '2021006174696085',
    out_trade_no: 'xm1',
    trade_status: 'TRADE_SUCCESS',
    total_amount: '9.90',
    extra: '',
    sign_type: 'RSA2',
    sign: '',
  };
  const content = buildSignedContent(payload, ['sign', 'sign_type']);
  assert.equal(content.includes('sign='), false);
  assert.equal(content.includes('extra='), false);
  payload.sign = signRsa2(content, pair.privateKey);
  assert.equal(verifyAlipayNotify(payload, pair.publicKey), true);
});

test('app pay order string contains signed RSA2 params', () => {
  const params = buildAppPayParams({
    appId: '2021006174696085',
    appPrivateKey: pair.privateKey,
    alipayPublicKey: pair.publicKey,
    notifyUrl: 'https://api.xmianai.com/shop/alipay/notify',
    gateway: 'https://openapi.alipay.com/gateway.do',
  }, {
    outTradeNo: 'xmtest1',
    totalAmount: '12.30',
    subject: '小眠商城',
  });
  assert.equal(params.method, 'alipay.trade.app.pay');
  assert.equal(params.sign_type, 'RSA2');
  assert.match(params.biz_content, /QUICK_MSECURITY_PAY/);
  assert.ok(params.sign.length > 80);
  const orderString = toOrderString(params);
  assert.match(orderString, /sign=/);
  assert.match(orderString, /notify_url=/);
});

test('paid trade statuses', () => {
  assert.equal(isPaidTradeStatus('TRADE_SUCCESS'), true);
  assert.equal(isPaidTradeStatus('TRADE_FINISHED'), true);
  assert.equal(isPaidTradeStatus('WAIT_BUYER_PAY'), false);
});
