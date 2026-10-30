#!/usr/bin/env node
/**
 * 热重载比对键：整份租户视图参与比较，秘密只以指纹参与。
 *
 * 背景：服务每 3 秒重读配置；漏掉任何运行期字段都会造成
 * 「改了配置却没重启租户」的静默漂移。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tenantConfigKey, tenantConfigView, tenantListKey } from '../src/ops/reload.mjs';

const BASE = {
  id: 't-abc',
  ownerId: 'owner@im.wechat',
  createdAt: '2026-10-30T00:00:00.000Z',
  botId: 'abc@im.bot',
  cwd: '/data/workspace/t-abc',
  root: '/data/tenants/t-abc',
  dshHome: '/data/tenants/t-abc/dsh-home',
  baseUrl: 'https://ilinkai.weixin.qq.com',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  persona: '你是助手',
  allowUsers: ['a@im.wechat', 'b@im.wechat'],
  maxChars: 1800,
  ackDelayMs: 15000,
  budgetTokensPerDay: 100000,
  budgetTokensPerMonth: 2000000,
  token: 'abc@im.bot:0600secret',
  apiKey: 'sk-secret-key-value-123456',
};

test('相同视图生成相同键', () => {
  assert.equal(tenantConfigKey(BASE), tenantConfigKey({ ...BASE }));
  assert.equal(
    tenantConfigKey(BASE),
    tenantConfigKey({ ...BASE, allowUsers: [...BASE.allowUsers] }),
  );
});

test('运行期字段变化都会改变键', () => {
  const patches = [
    { ownerId: 'other@im.wechat' },
    { cwd: '/data/workspace/other' },
    { root: '/data/tenants/other' },
    { dshHome: '/data/tenants/other/dsh-home' },
    { baseUrl: 'https://example.com' },
    { model: 'deepseek-pro' },
    { provider: 'other' },
    { persona: '换一个' },
    { allowUsers: ['a@im.wechat'] },
    { maxChars: 4000 },
    { ackDelayMs: 5000 },
    { budgetTokensPerDay: 1 },
    { budgetTokensPerMonth: 1 },
    { createdAt: '2026-10-31T00:00:00.000Z' },
  ];

  for (const patch of patches) {
    assert.notEqual(
      tenantConfigKey({ ...BASE, ...patch }),
      tenantConfigKey(BASE),
      `字段变化未进入比对键: ${JSON.stringify(patch)}`,
    );
  }
});

test('秘密只以指纹参与，键里没有明文', () => {
  const key = tenantConfigKey(BASE);
  assert.ok(!key.includes('0600secret'), '键里出现了 bot token 明文');
  assert.ok(!key.includes('sk-secret-key-value-123456'), '键里出现了 API key 明文');

  assert.notEqual(tenantConfigKey({ ...BASE, token: 'abc@im.bot:newsecret' }), key);
  assert.notEqual(tenantConfigKey({ ...BASE, apiKey: 'sk-another-key-987654' }), key);
});

test('allowUsers 顺序无语义，重排不触发重启', () => {
  const reordered = { ...BASE, allowUsers: [...BASE.allowUsers].reverse() };
  assert.equal(tenantConfigKey(reordered), tenantConfigKey(BASE));
});

test('tenantListKey 与租户顺序无关', () => {
  const a = { ...BASE, id: 't-a' };
  const b = { ...BASE, id: 't-b' };
  assert.equal(tenantListKey([a, b]), tenantListKey([b, a]));
  assert.notEqual(tenantListKey([a]), tenantListKey([a, b]));
});

test('undefined 字段被视为不存在', () => {
  const withUndefined = { ...BASE, extra: undefined };
  assert.equal(tenantConfigKey(withUndefined), tenantConfigKey(BASE));
  assert.equal('extra' in tenantConfigView(withUndefined), false);
});
