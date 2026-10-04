const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createConversationStore } = require('../src/conversation-store');
const { mainHarness } = require('./main-harness');

async function temporaryStore(t) {
  const root = os.tmpdir();
  const directory = await fs.mkdtemp(path.join(root, 'companion-ledger-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), root);
    assert.ok(path.basename(directory).startsWith('companion-ledger-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return createConversationStore(directory);
}

test('preserves UTF-8, Markdown and long answers; appends across restarts in one dated file', async (t) => {
  const store = await temporaryStore(t);
  const longAnswer = '# 回答\n\n```js\nconst value = "鲸鱼";\n```\n' + '完整内容🐳\n'.repeat(10000);
  const firstTime = new Date(2026, 9, 4, 23, 59, 59).getTime();
  await store.appendExchange({ question: '老师的中文问题？', answer: longAnswer, askedAt: firstTime });
  const restarted = createConversationStore(store.directory);
  await restarted.initialize();
  await restarted.appendExchange({ question: '第二个问题', answer: '第二个回答', askedAt: firstTime });
  await restarted.appendExchange({ question: '下一天', answer: '已跨日', askedAt: new Date(2026, 9, 5, 0, 0, 1).getTime() });
  const content = await fs.readFile(store.filePath, 'utf8');
  assert.ok(content.includes(longAnswer));
  assert.ok(content.includes('老师的中文问题？'));
  assert.ok(content.includes('23:59:59'));
  assert.equal((content.match(/^## 2026-10-04$/gm) || []).length, 1);
  assert.equal((content.match(/^## 2026-10-05$/gm) || []).length, 1);
  assert.deepEqual(await fs.readdir(store.directory), ['对话积累.md']);
});

test('serializes overlapping writes and records failed requests', async (t) => {
  const store = await temporaryStore(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.appendExchange({
    question: `问题-${i}`, answer: `回答-${i}`, askedAt: new Date(2026, 9, 4, 10, 0, i).getTime(), failed: i === 11,
  })));
  const content = await fs.readFile(store.filePath, 'utf8');
  for (let i = 0; i < 12; i++) assert.equal(content.split(`**老师 · 提问**\n\n问题-${i}\n`).length - 1, 1);
  assert.equal((content.match(/^## 2026-10-04$/gm) || []).length, 1);
  assert.ok(content.includes('10:00:11 · 请求未完成'));
});

test('reports write failures and can retry after the directory becomes writable', async (t) => {
  const store = await temporaryStore(t);
  const blocker = path.join(store.directory, 'blocked');
  await fs.writeFile(blocker, 'file, not directory');
  const blockedStore = createConversationStore(blocker);
  await assert.rejects(blockedStore.appendExchange({ question: '问题', answer: '回答' }));
  await fs.unlink(blocker);
  await blockedStore.appendExchange({ question: '恢复写入', answer: '成功' });
  assert.ok((await fs.readFile(blockedStore.filePath, 'utf8')).includes('恢复写入'));
});

test('main IPC archives time, weather, model answers and errors; clear-chat preserves disk history', async (t) => {
  const store = await temporaryStore(t);
  const { invoke } = await mainHarness(t, { store, fetchImpl: async (url) => {
    const data = url.includes('geocoding-api')
      ? { results: [{ name: '北京', latitude: 39.9, longitude: 116.4 }] }
      : url.includes('api.open-meteo')
        ? { current: { temperature_2m: 20, apparent_temperature: 19, weather_code: 0 }, daily: { temperature_2m_max: [23], temperature_2m_min: [15] } }
        : { output: [{ type: 'message', content: [{ type: 'output_text', text: '模型测试回答\n\n完整段落。' }] }] };
    return { ok: true, json: async () => data };
  } });
  const time = await invoke('chat:send', '现在几点？');
  const weather = await invoke('chat:send', '今日天气如何？');
  const model = await invoke('chat:send', '你好，请聊聊读书。');
  assert.equal(time.kind, 'time');
  assert.equal(weather.kind, 'weather');
  assert.equal(model.kind, 'model');
  const beforeClear = await fs.readFile(store.filePath, 'utf8');
  for (const reply of [time, weather, model]) assert.ok(beforeClear.includes(reply.text));
  await invoke('chat:clear');
  assert.equal(await fs.readFile(store.filePath, 'utf8'), beforeClear);
  const { invoke: failedInvoke } = await mainHarness(t, { store, fetchImpl: async () => ({
    ok: false, status: 401, json: async () => ({ error: { message: '模拟服务失败' } }),
  }) });
  const failure = await failedInvoke('chat:send', '模拟失败提问');
  assert.equal(failure.error, '模拟服务失败');
  const content = await fs.readFile(store.filePath, 'utf8');
  assert.ok(content.includes('模拟失败提问'));
  assert.ok(content.includes('模拟服务失败'));
  assert.ok(content.includes('请求未完成'));
});

test('an archive failure does not suppress the answer and returns a visible warning', async (t) => {
  const { invoke } = await mainHarness(t, { store: {
    filePath: path.join(os.tmpdir(), 'unwritable-ledger', '对话积累.md'),
    appendExchange: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  }, fetchImpl: async () => { throw new Error('unexpected network call'); } });
  const result = await invoke('chat:send', '现在几点？');
  assert.ok(result.text.startsWith('现在是'));
  assert.ok(result.archiveError.includes('本次对话未能保存'));
  assert.ok(result.archiveError.includes('EACCES'));
});
