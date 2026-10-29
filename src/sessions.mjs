/**
 * 委托会话与证据截图。
 * - 会话：保存执行模型的对话（messages），调用方 Agent 带上 session_id 再调用 computer_use 时接着执行。
 *   只保存在当前 MCP 连接的内存里，闲置超过 ttl 或超过数量上限时丢弃最旧的。
 * - 证据：执行模型的 js 返回的截图写入临时目录（每个会话一个子目录），调用方 Agent 可按路径打开原图。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const EVIDENCE_DIRECTORY = path.join(os.tmpdir(), 'magpie-computer-use', 'evidence');
const EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

// 文件名里的标签：保留中英文与数字，其余换成短横线。
const slug = label => label.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'screen';

export function createSessionStore({
  directory = EVIDENCE_DIRECTORY, ttlMs = 30 * 60 * 1000, max = 10, now = Date.now, id = randomUUID,
} = {}) {
  const sessions = new Map();
  let swept = false;

  function expire() {
    for (const [key, session] of sessions) if (now() - session.updatedAt > ttlMs) sessions.delete(key);
    while (sessions.size > max) sessions.delete(sessions.keys().next().value);
  }

  // 第一次写证据时顺便清理一天前其他会话留下的目录。
  async function sweep() {
    if (swept) return;
    swept = true;
    for (const name of await fs.readdir(directory).catch(() => [])) {
      const target = path.join(directory, name);
      const stat = await fs.stat(target).catch(() => null);
      if (stat && now() - stat.mtimeMs > EVIDENCE_MAX_AGE_MS) await fs.rm(target, { recursive: true, force: true });
    }
  }

  return {
    /** 取出未过期的会话；不存在时返回 undefined。 */
    get(sessionId) {
      expire();
      return sessions.get(sessionId);
    },

    create() {
      const session = { id: id(), messages: null, lastImage: undefined, evidence: 0, updatedAt: now() };
      sessions.set(session.id, session);
      expire();
      return session;
    },

    /** 记下本次执行后的对话，并把会话移到最新。 */
    update(session, { messages, lastImage }) {
      session.messages = messages;
      session.lastImage = lastImage;
      session.updatedAt = now();
      sessions.delete(session.id);
      sessions.set(session.id, session);
      expire();
    },

    /**
     * 把截图写成文件，返回带编号与路径的证据；写文件失败时保留图片、路径为 null。
     * 截图已带编号（执行时就告诉了执行模型）时沿用，否则接着会话的编号往下排。
     */
    async saveEvidence(session, items) {
      if (!items.length) return [];
      await sweep();
      const folder = path.join(directory, session.id);
      const saved = [];
      const take = item => {
        const number = item.number ?? session.evidence + 1;
        session.evidence = Math.max(session.evidence, number);
        return number;
      };
      try {
        await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      } catch {
        return items.map(item => ({ ...item, number: take(item), file: null }));
      }
      for (const item of items) {
        const number = take(item);
        const extension = EXTENSIONS[item.image.mimeType] ?? 'png';
        const file = path.join(folder, `${String(number).padStart(2, '0')}-${slug(item.label)}.${extension}`);
        try {
          await fs.writeFile(file, Buffer.from(item.image.data, 'base64'), { mode: 0o600 });
          saved.push({ ...item, number, file });
        } catch {
          saved.push({ ...item, number, file: null });
        }
      }
      return saved;
    },
  };
}
