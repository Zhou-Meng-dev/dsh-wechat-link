#!/usr/bin/env node
/**
 * 模拟"微信消息"的命令行测试台。
 *
 * 用法：
 *   node src/cli-sim.mjs              交互式（输入一行发一条）
 *   node src/cli-sim.mjs --script a b 批量：依次发送多条
 *   node src/cli-sim.mjs --peer alice 指定"微信用户"身份（默认 sim-user）
 *
 * 环境变量：
 *   DSH_HOME   覆盖 DSH 主目录
 *   DSH_CWD    会话工作目录（默认本仓库根）
 *   DSH_MODEL  模型名（默认 deepseek-v4-flash）
 */

import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DshClient } from './agent/sdk-client.mjs';
import { ConversationManager } from './agent/conversation.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const args = process.argv.slice(2);
const scriptIdx = args.indexOf('--script');
const peerIdx = args.indexOf('--peer');

const peer = peerIdx >= 0 ? args[peerIdx + 1] : 'sim-user';
const script = scriptIdx >= 0 ? args.slice(scriptIdx + 1) : null;

const client = new DshClient({
  cwd: process.env.DSH_CWD ?? repoRoot,
  dshHome: process.env.DSH_HOME,
  provider: process.env.DSH_PROVIDER ?? 'deepseek-official',
  model: process.env.DSH_MODEL ?? 'deepseek-v4-flash',
});

client.on('stderr', (line) => {
  // dsh 的 stderr 里会有推理增量与诊断，测试时只在出错才显示
  if (/error|fail|Error/i.test(line)) console.error('[dsh]', line.slice(0, 200));
});

const conv = new ConversationManager(client, {
  log: (m) => console.error(`[sim] ${m}`),
});

async function askAndPrint(text) {
  process.stdout.write(`\n👤 [${peer}] ${text}\n`);
  const t0 = Date.now();
  try {
    const reply = await conv.ask(peer, text);
    const ms = Date.now() - t0;
    console.log(`🤖 ${reply || '(空回复)'}`);
    console.log(`   ⏱ ${ms}ms`);
  } catch (err) {
    console.error(`⚠️  失败: ${err.message}`);
  }
}

async function main() {
  console.log('启动 DSH SDK 子进程…');
  const info = await client.start();
  console.log(`✅ 就绪: ${info?.name} ${info?.version}`);
  console.log(`   用户: ${peer}   工作目录: ${process.env.DSH_CWD ?? repoRoot}`);
  console.log(`   模型: ${process.env.DSH_MODEL ?? 'deepseek-v4-flash'}`);
  console.log('   命令: /new 开新会话, /stats 状态, /quit 退出\n');

  if (script) {
    for (const text of script) {
      if (text === '/new') {
        conv.reset(peer);
        console.log('🔄 已开新会话');
        continue;
      }
      await askAndPrint(text);
    }
    await cleanup();
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    let line;
    try {
      line = await rl.question('> ');
    } catch {
      break;
    }
    const text = line.trim();
    if (!text) continue;
    if (text === '/quit' || text === '/exit') break;
    if (text === '/new') {
      conv.reset(peer);
      console.log('🔄 已开新会话');
      continue;
    }
    if (text === '/stats') {
      console.log(JSON.stringify(conv.stats()));
      continue;
    }
    await askAndPrint(text);
  }
  rl.close();
  await cleanup();
}

async function cleanup() {
  await client.shutdown();
  // 给子进程一点时间优雅退出
  await new Promise((r) => setTimeout(r, 300));
  client.kill();
}

main().catch(async (err) => {
  console.error('致命错误:', err);
  await cleanup();
  process.exit(1);
});
