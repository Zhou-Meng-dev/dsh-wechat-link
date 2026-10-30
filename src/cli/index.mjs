/**
 * CLI 分发：只做 argv 分支、帮助/版本输出与错误处理。
 * 具体命令实现在 ./commands/*.mjs，帮助文案在 ./help.mjs。
 */

import { VERSION } from '../version.mjs';
import { cmdApikey } from './commands/apikey.mjs';
import { cmdPersona, cmdPlugin, cmdSkills } from './commands/capabilities.mjs';
import { cmdDoctor } from './commands/doctor.mjs';
import { cmdLogin } from './commands/login.mjs';
import { cmdServe } from './commands/serve.mjs';
import { cmdSetup } from './commands/setup.mjs';
import { cmdTask } from './commands/task.mjs';
import { cmdUsage } from './commands/usage.mjs';
import { cmdList, cmdRemove } from './commands/tenants.mjs';
import { CLI } from './context.mjs';
import { printHelp } from './help.mjs';

export async function runCli(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;

  try {
    switch (cmd) {
      case 'login':
        await cmdLogin(rest);
        break;
      case 'list':
      case 'ls':
        await cmdList();
        break;
      case 'rm':
      case 'remove':
        await cmdRemove(rest);
        break;
      case 'skills':
        await cmdSkills(rest);
        break;
      case 'persona':
        await cmdPersona(rest);
        break;
      case 'plugin':
        await cmdPlugin(rest);
        break;
      case 'apikey':
        await cmdApikey(rest);
        break;
      case 'task':
        await cmdTask(rest);
        break;
      case 'usage':
        await cmdUsage(rest);
        break;
      case 'doctor':
      case 'check':
        await cmdDoctor(rest);
        break;
      case 'setup':
      case 'init':
        await cmdSetup();
        break;
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        break;
      case 'version':
      case '--version':
      case '-V':
      case '-v':
        // 包名 + 版本，便于脚本解析；不掺调用形态（三种运行方式输出一致）
        console.log(`dsh-wechat-link ${VERSION}`);
        console.log(`node ${process.version} (${process.platform}-${process.arch})`);
        break;
      case undefined:
        // 无参数 = 常驻服务。systemd / Docker / systemd unit 都靠这个入口。
        await cmdServe();
        break;
      default: {
        // 未知命令必须报错退出，不能落到常驻服务（敲错一个字就会连真微信）。
        const shown = String(cmd).startsWith('-') ? cmd : `「${cmd}」`;
        console.error(`未知命令: ${shown}`);
        console.error(`运行 "${CLI} -h" 查看可用命令。`);
        process.exit(1);
      }
    }
  } catch (err) {
    console.error('❌', err.message);
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
  }
}
