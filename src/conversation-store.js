const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const FILE_HEADER = '# 桌宠对话积累\n\n按提问时的本地日期与时间记录，后续问答自动追加到本文件。\n';

function normalizeConversationDirectory(value) {
  let directory = String(value || '').trim();
  if ((directory.startsWith('"') && directory.endsWith('"')) ||
      (directory.startsWith("'") && directory.endsWith("'"))) {
    directory = directory.slice(1, -1).trim();
  }
  if (!directory || directory.includes('\0') || !path.isAbsolute(directory)) {
    throw new Error('请填写完整的文件夹路径。');
  }
  if (process.platform === 'win32') {
    const drivePath = /^[a-z]:[\\/]/i.test(directory);
    const networkPath = /^\\\\[^\\/?*.]+\\[^\\/?*]+/.test(directory);
    if ((!drivePath && !networkPath) || /[<>"|?*]/.test(directory) || /:/.test(directory.slice(drivePath ? 2 : 0))) {
      throw new Error('文件夹路径格式不正确，请重新选择。');
    }
  }
  return path.normalize(directory);
}

function localDateParts(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('对话时间无效。');
  const pad = (number) => String(number).padStart(2, '0');
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  };
}

function createConversationStore(directory = path.join(os.homedir(), 'Documents', '对话积累')) {
  directory = normalizeConversationDirectory(directory);
  const filePath = path.join(directory, '对话积累.md');
  let queue = Promise.resolve();
  let initialized = false;
  let lastDay = '';

  function enqueue(operation) {
    const pending = queue.then(operation);
    // A failed write must not prevent later exchanges from being saved.
    queue = pending.catch(() => {});
    return pending;
  }

  async function initializeFile() {
    if (initialized) return;
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(filePath, FILE_HEADER, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const existing = await fs.readFile(filePath, 'utf8');
    const days = [...existing.matchAll(/^<!-- companion-date:(\d{4}-\d{2}-\d{2}) -->$/gm)];
    lastDay = days.at(-1)?.[1] || '';
    initialized = true;
  }

  async function ensureWritable() {
    await initializeFile();
    const handle = await fs.open(filePath, 'a');
    await handle.close();
  }

  async function appendExchange({ question, answer, petName = '鲸鱼娘', askedAt = Date.now(), failed = false }) {
    if (typeof question !== 'string' || !question.trim() || typeof answer !== 'string') {
      throw new Error('问答记录格式无效。');
    }
    const { day, time } = localDateParts(askedAt);
    const name = String(petName).replace(/[\r\n*]/g, '').trim() || '鲸鱼娘';
    return enqueue(async () => {
      try {
        await initializeFile();
        const dateHeading = day === lastDay ? '' : `\n## ${day}\n<!-- companion-date:${day} -->\n`;
        const entry = `${dateHeading}\n### ${time}${failed ? ' · 请求未完成' : ''}\n\n**老师 · 提问**\n\n${question}\n\n**${name} · ${failed ? '提示' : '回答'}**\n\n${answer}\n\n---\n`;
        await fs.appendFile(filePath, entry, 'utf8');
        lastDay = day;
        return filePath;
      } catch (error) {
        initialized = false;
        throw error;
      }
    });
  }

  return {
    directory,
    filePath,
    initialize: () => enqueue(initializeFile),
    ensureWritable: () => enqueue(ensureWritable),
    appendExchange,
  };
}

module.exports = { createConversationStore, normalizeConversationDirectory, localDateParts };
