/**
 * 下行消息的幂等键（client_id）生成器。
 *
 * ilink.mjs / outbox.mjs / reply.mjs 共用同一实现，避免三处格式漂移。
 * 语义：一次逻辑发送在重试（原地重试、入队补发）时必须复用同一个值。
 */

import { randomBytes } from 'node:crypto';

/** 生成一条下行消息的幂等键 */
export function newClientId() {
  return `dsh-${randomBytes(6).toString('hex')}`;
}
