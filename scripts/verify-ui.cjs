const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rootDirectory = path.resolve(__dirname, '..');
const outputDirectory = path.join(rootDirectory, 'dist', 'ui-check');
const defaults = {
  petName: '鲸鱼娘', city: '上海', reasoningEffort: 'medium',
  proactiveEnabled: false, voiceEnabled: false, alwaysOnTop: false, launchAtLogin: false,
  scale: 1, chatLayout: 'standard', apiKeySet: false,
  petOpacity: 100, chatOpacity: 80, messageOpacity: 88,
  inputOpacity: 92, textOpacity: 100, bubbleOpacity: 50,
  conversationDirectory: 'D:\\鲸鱼娘\\对话积累',
};

function installMockBridge() {
  const { contextBridge, ipcRenderer } = require('electron');
  let settings = { ...defaults };
  let pendingAnswer;
  const callbacks = new Map();
  const calls = [];
  const record = (name, value) => calls.push({ name, value });
  const subscribe = (name) => (callback) => {
    callbacks.set(name, callback);
    return () => callbacks.delete(name);
  };
  contextBridge.exposeInMainWorld('petAPI', {
    getSettings: async () => ({ ...settings }),
    saveSettings: async (values) => {
      record('saveSettings', values);
      settings = { ...settings, ...values };
      return { ...settings };
    },
    clearApiKey: async () => { settings.apiKeySet = false; },
    getWeather: async () => ({ city: '上海', condition: '晴', temperature: 24, feelsLike: 24, low: 18, high: 26, rainChance: 0 }),
    sendChat: (message) => {
      record('sendChat', message);
      return new Promise((resolve) => { pendingAnswer = resolve; });
    },
    clearChat: async () => record('clearChat'),
    setChatLayout: async (layout) => { settings.chatLayout = layout; return layout; },
    setIgnoreMouse: () => {},
    moveBy: (x, y) => record('moveBy', { x, y }),
    openApiKeys: async () => record('openApiKeys'),
    openConversationFolder: async () => record('openConversationFolder'),
    chooseConversationDirectory: async () => 'D:\\鲸鱼娘\\选定目录',
    hide: () => record('hide'),
    quit: () => record('quit'),
    onOpenChat: subscribe('chat'),
    onOpenSettings: subscribe('settings'),
    onOpenContextPreview: subscribe('context'),
    onRequestWeather: subscribe('weather'),
  });
  contextBridge.exposeInMainWorld('__qa', {
    emit: (event) => callbacks.get(event)?.(),
    snapshot: () => ({ settings: { ...settings }, calls: [...calls], answerPending: Boolean(pendingAnswer) }),
    answer: (text) => {
      const resolve = pendingAnswer;
      pendingAnswer = undefined;
      resolve?.({ kind: 'model', text });
    },
  });
  window.addEventListener('error', (event) => ipcRenderer.send('qa:renderer-error', event.message));
  window.addEventListener('unhandledrejection', (event) => ipcRenderer.send('qa:renderer-error', String(event.reason)));
}

async function runElectronChecks() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const assert = require('node:assert/strict');
  const profileDirectory = process.env.WHALE_GIRL_QA_PROFILE;
  assert(profileDirectory, 'Run this check with node scripts/verify-ui.cjs');
  for (const name of ['profile', 'session']) fs.mkdirSync(path.join(profileDirectory, name));
  app.setPath('userData', path.join(profileDirectory, 'profile'));
  app.setPath('sessionData', path.join(profileDirectory, 'session'));
  app.disableHardwareAcceleration();
  const results = [];
  const rendererErrors = [];
  const networkRequests = [];
  const check = (name, condition, details = {}) => {
    assert(condition, `${name}: ${JSON.stringify(details)}`);
    results.push({ ...details, name, passed: true });
  };
  ipcMain.on('qa:renderer-error', (_event, message) => rendererErrors.push(message));
  await app.whenReady();
  fs.mkdirSync(outputDirectory, { recursive: true });
  const window = new BrowserWindow({
    show: false, width: 780, height: 720, useContentSize: true,
    frame: false, transparent: true,
    webPreferences: {
      preload: __filename, contextIsolation: true, nodeIntegration: false,
      sandbox: false, backgroundThrottling: false, offscreen: true,
      partition: 'whale-girl-ui-check',
    },
  });
  window.webContents.setFrameRate(30);
  window.webContents.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    ({ url }, callback) => { networkRequests.push(url); callback({ cancel: true }); },
  );
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const evaluate = (script) => window.webContents.executeJavaScript(script);
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const settle = () => delay(380);
  const waitFor = async (expression) => {
    for (let count = 0; count < 50; count += 1) {
      if (await evaluate(expression)) return;
      await delay(40);
    }
    throw new Error(`UI condition timed out: ${expression}`);
  };
  const capture = async (name) => {
    await settle();
    const image = await window.webContents.capturePage();
    fs.writeFileSync(path.join(outputDirectory, `${name}.png`), image.toPNG());
  };
  await window.loadFile(path.join(rootDirectory, 'src', 'index.html'), { query: { preview: '1' } });
  await waitFor('document.querySelectorAll("#messages .message").length === 1');
  await evaluate('Promise.all([...document.images].map(image => image.decode()))');
  await delay(750);
  await evaluate('window.__qa.emit("chat")');
  await capture('standard');

  const opacityDefaults = await evaluate(`Object.fromEntries(
    ['pet', 'chat', 'message', 'input', 'text', 'bubble'].map(name =>
      [name, Number(getComputedStyle(document.documentElement).getPropertyValue('--' + name + '-opacity'))]))`);
  check('default opacity values', JSON.stringify(Object.values(opacityDefaults)) === JSON.stringify([1, .8, .88, .92, 1, .5]), opacityDefaults);
  await evaluate('window.__qa.emit("settings")');
  await capture('settings');
  const settingsGeometry = await evaluate(`(() => {
    const panel = document.querySelector('#settingsPanel').getBoundingClientRect();
    const save = document.querySelector('.settings-actions .primary-button').getBoundingClientRect();
    const scroller = document.querySelector('.settings-content');
    return { panelTop: panel.top, panelBottom: panel.bottom, saveTop: save.top, saveBottom: save.bottom,
      viewHeight: innerHeight, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight };
  })()`);
  check('save button visible within settings and viewport', settingsGeometry.saveTop >= settingsGeometry.panelTop && settingsGeometry.saveBottom <= settingsGeometry.panelBottom && settingsGeometry.saveBottom <= settingsGeometry.viewHeight, settingsGeometry);
  await evaluate('document.querySelector(".settings-content").scrollTop = document.querySelector(".settings-content").scrollHeight');
  await capture('settings-bottom');
  const directoryGeometry = await evaluate(`(() => {
    const input = document.querySelector('#conversationDirectoryInput').getBoundingClientRect();
    const scroll = document.querySelector('.settings-content').getBoundingClientRect();
    return { inputTop: input.top, inputBottom: input.bottom, scrollTop: scroll.top, scrollBottom: scroll.bottom };
  })()`);
  check('directory input reachable by scrolling', directoryGeometry.inputTop >= directoryGeometry.scrollTop && directoryGeometry.inputBottom <= directoryGeometry.scrollBottom, directoryGeometry);

  const opacityPreview = { petOpacity: 65, chatOpacity: 35, messageOpacity: 55, inputOpacity: 60, textOpacity: 45, bubbleOpacity: 40 };
  await evaluate(`(() => {
    for (const [name, value] of Object.entries(${JSON.stringify(opacityPreview)})) {
      const input = document.querySelector('#' + name + 'Input');
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  const previewStyles = await evaluate(`(() => {
    const style = element => getComputedStyle(document.querySelector(element));
    return { pet: style('#petVisual').opacity, chat: style('#chatPanel').backgroundColor,
      message: style('.message .bubble').backgroundColor, composer: style('.composer').backgroundColor,
      text: style('.message .bubble').color, bubble: style('#speechBubble').backgroundColor };
  })()`);
  check('opacity sliders update actual CSS surfaces independently',
    previewStyles.pet === '0.65' && previewStyles.chat.endsWith('0.35)') && previewStyles.message.endsWith('0.55)') &&
    previewStyles.composer.endsWith('0.6)') && previewStyles.text.endsWith('0.45)') && previewStyles.bubble.endsWith('0.4)'), previewStyles);
  await evaluate('document.querySelector("#chooseConversationDirectoryBtn").click()');
  await waitFor('document.querySelector("#conversationDirectoryInput").value.endsWith("选定目录")');
  const pastedDirectory = 'D:\\Whale Girl\\对话存档';
  await evaluate(`document.querySelector('#conversationDirectoryInput').value = ${JSON.stringify(pastedDirectory)};
    document.querySelector('#settingsForm').requestSubmit();`);
  await waitFor('!document.querySelector("#settingsPanel").classList.contains("open")');
  const saved = await evaluate('window.__qa.snapshot().settings');
  check('pasted directory and opacity settings saved', saved.conversationDirectory === pastedDirectory && Object.entries(opacityPreview).every(([name, value]) => saved[name] === value));
  await evaluate('window.__qa.emit("settings")');
  check('saved directory restored in settings', await evaluate(`document.querySelector('#conversationDirectoryInput').value === ${JSON.stringify(pastedDirectory)}`));
  await evaluate(`(() => {
    for (const [name, value] of Object.entries(${JSON.stringify(defaults)})) {
      const input = document.querySelector('#' + name + 'Input');
      if (input && input.type === 'range') input.value = String(value);
    }
    document.querySelector('#settingsForm').requestSubmit();
  })()`);
  await waitFor('!document.querySelector("#settingsPanel").classList.contains("open")');

  await evaluate('window.__qa.emit("chat"); document.querySelector("#chatScaleBtn").click()');
  await capture('wide');
  let layout = await evaluate('({ name: document.querySelector("#app").dataset.chatLayout, width: document.querySelector("#chatPanel").getBoundingClientRect().width, height: document.querySelector("#chatPanel").getBoundingClientRect().height })');
  check('wide layout dimensions', layout.name === 'wide' && layout.width === 430 && layout.height === 654, layout);
  await evaluate('document.querySelector("#chatScaleBtn").click()');
  await capture('compact');
  layout = await evaluate('({ name: document.querySelector("#app").dataset.chatLayout, width: document.querySelector("#chatPanel").getBoundingClientRect().width, height: document.querySelector("#chatPanel").getBoundingClientRect().height })');
  check('compact layout dimensions', layout.name === 'compact' && layout.width === 316 && layout.height === 500, layout);
  await evaluate('document.querySelector("#chatScaleBtn").click()');
  await settle();
  await evaluate('document.querySelector("#chatInput").value = "陪我整理一个清晰的小计划吧。"; document.querySelector("#chatForm").requestSubmit()');
  await waitFor('window.__qa.snapshot().answerPending');
  check('model request switches to happy pose', await evaluate('document.querySelector("#petVisual").classList.contains("happy") && document.querySelector("#bubbleText").textContent === "老师，让我想想..."'));
  await capture('happy');
  const longAnswer = Array.from({ length: 180 }, (_, index) => `第 ${index + 1} 段：把任务拆成清晰的小步骤，完成一件后再继续下一件。保留每个想法与细节，也给自己留一点休息的空间。`).join('\n\n') + '\n\n完整回答的最后一行。';
  await evaluate(`window.__qa.answer(${JSON.stringify(longAnswer)})`);
  await waitFor('!document.querySelector("#sendBtn").disabled');
  await settle();
  const answerGeometry = await evaluate(`(() => {
    const answer = document.querySelector('.message.answer .bubble');
    const messages = document.querySelector('#messages');
    const style = getComputedStyle(answer);
    const bounds = answer.getBoundingClientRect();
    const viewport = messages.getBoundingClientRect();
    return { text: answer.textContent, height: bounds.height, scrollHeight: answer.scrollHeight,
      maxHeight: style.maxHeight, overflowY: style.overflowY, lineClamp: style.webkitLineClamp,
      messageScrollHeight: messages.scrollHeight, messageClientHeight: messages.clientHeight,
      answerBottom: bounds.bottom, viewportBottom: viewport.bottom,
      happy: document.querySelector('#petVisual').classList.contains('happy') };
  })()`);
  check('long answer preserved without clipping', answerGeometry.text === longAnswer && answerGeometry.maxHeight === 'none' &&
    answerGeometry.overflowY === 'visible' && answerGeometry.lineClamp === 'none' &&
    Math.abs(answerGeometry.height - answerGeometry.scrollHeight) <= 1 &&
    answerGeometry.messageScrollHeight > answerGeometry.messageClientHeight &&
    answerGeometry.answerBottom <= answerGeometry.viewportBottom, { characters: longAnswer.length, height: answerGeometry.height, scrollHeight: answerGeometry.messageScrollHeight });
  check('model completion restores resting pose', !answerGeometry.happy);
  await capture('long-answer-bottom');
  await evaluate('window.__qa.emit("settings"); document.querySelector("#scaleInput").value = "1.18"; document.querySelector("#scaleInput").dispatchEvent(new Event("input", { bubbles: true }))');
  const bubbleTop = await evaluate('parseFloat(getComputedStyle(document.querySelector("#speechBubble")).top)');
  check('greeting stays inside stage at largest scale', bubbleTop >= 12, { bubbleTop });
  check('renderer raised no errors', rendererErrors.length === 0, { rendererErrors });
  check('no external requests attempted', networkRequests.length === 0, { networkRequests });
  fs.writeFileSync(path.join(outputDirectory, 'results.json'), JSON.stringify({ passed: true, checks: results }, null, 2));
  console.log(`Passed ${results.length} UI checks. Screenshots: ${outputDirectory}`);
  window.destroy();
  app.quit();
}

function runIsolatedWorker() {
  const { spawnSync } = require('node:child_process');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-girl-ui-check-'));
  let exitCode = 1;
  try {
    const environment = { ...process.env, WHALE_GIRL_QA_PROFILE: temporaryRoot };
    delete environment.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [__filename, '--ui-check-worker'], {
      cwd: rootDirectory, env: environment, stdio: 'inherit', windowsHide: true, timeout: 60000,
    });
    if (result.error) throw result.error;
    exitCode = result.status ?? 1;
  } finally {
    const resolved = path.resolve(temporaryRoot);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('whale-girl-ui-check-')) {
      throw new Error('Unexpected temporary profile path');
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  process.exitCode = exitCode;
}

if (process.type === 'renderer') {
  installMockBridge();
} else if (process.versions.electron && process.argv.includes('--ui-check-worker')) {
  runElectronChecks().catch((error) => {
    console.error(error);
    require('electron').app.exit(1);
  });
} else {
  runIsolatedWorker();
}
