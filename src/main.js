const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  screen,
  shell,
  Tray,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createConversationStore, normalizeConversationDirectory } = require('./conversation-store');

const PREVIEW_MODE = Boolean(process.env.QINGYU_SCREENSHOT_PATH);
const MODEL = 'deepseek-v4-flash';

const WINDOW_WIDTH = 780;
const WINDOW_HEIGHT = 720;
const CHAT_PANEL = Object.freeze({ left: 8, top: 29, height: 654 });
const PET_BASE_WIDTH = 403;
const PET_TRANSFORM_ORIGIN_X = 0.55;
const PET_VISIBLE_FRACTION = 0.875;
const PET_EDGE_MARGIN = 4;
const WINDOW_BOTTOM_OVERFLOW = 6;
const DEFAULT_SETTINGS = Object.freeze({
  petName: '鲸鱼娘',
  city: '上海',
  reasoningEffort: 'medium',
  proactiveEnabled: true,
  voiceEnabled: false,
  quietStart: 23,
  quietEnd: 8,
  scale: 1,
  chatLayout: 'standard',
  alwaysOnTop: true,
  launchAtLogin: false,
  petOpacity: 100,
  chatOpacity: 80,
  messageOpacity: 88,
  inputOpacity: 92,
  textOpacity: 100,
  bubbleOpacity: 50,
});

let mainWindow;
let tray;
let quitting = false;
let settings = { ...DEFAULT_SETTINGS };
let sessionApiKey = '';
let chatHistory = [];
let weatherCache = null;
let moveSaveTimer = null;
let conversationStore;
let settingsSaveQueue = Promise.resolve();

function configureUserData() {
  const dataRoot = app.getPath('appData');
  const directory = PREVIEW_MODE
    ? fs.mkdtempSync(path.join(app.getPath('temp'), 'whale-girl-preview-'))
    : path.join(dataRoot, 'whale-girl');
  app.setPath('userData', directory);
  fs.mkdirSync(directory, { recursive: true });
  if (!PREVIEW_MODE) {
    const legacyDirectory = path.join(dataRoot, 'qingyu-desktop-companion');
    for (const filename of ['settings.json', 'deepseek-key.bin']) {
      const source = path.join(legacyDirectory, filename);
      const target = path.join(directory, filename);
      if (!fs.existsSync(target) && fs.existsSync(source)) {
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      }
    }
  }
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function secretPath() {
  return path.join(app.getPath('userData'), 'deepseek-key.bin');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadSettings() {
  const stored = readJson(settingsPath(), {});
  const saved = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const defaultDirectory = path.join(PREVIEW_MODE ? app.getPath('userData') : app.getPath('documents'), '对话积累');
  if (/^(hazuki|青屿)$/i.test(String(saved.petName || '').trim())) saved.petName = DEFAULT_SETTINGS.petName;
  try {
    saved.conversationDirectory = normalizeConversationDirectory(saved.conversationDirectory || defaultDirectory);
  } catch {
    saved.conversationDirectory = defaultDirectory;
  }
  settings = normalizeSettings(saved, { ...DEFAULT_SETTINGS, conversationDirectory: defaultDirectory });
  conversationStore = createConversationStore(settings.conversationDirectory);
  persistSettings();
}

function persistSettings(value = settings) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const temporaryPath = `${settingsPath()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporaryPath, settingsPath());
}

function getApiKey() {
  if (sessionApiKey) return sessionApiKey;
  try {
    if (!safeStorage.isEncryptionAvailable()) return '';
    const encrypted = fs.readFileSync(secretPath());
    return safeStorage.decryptString(encrypted);
  } catch {
    return '';
  }
}

function saveApiKey(apiKey) {
  const value = String(apiKey || '').trim();
  if (!value) return;
  if (safeStorage.isEncryptionAvailable()) {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(secretPath(), safeStorage.encryptString(value));
    sessionApiKey = '';
  } else {
    sessionApiKey = value;
  }
}

function clearApiKey() {
  sessionApiKey = '';
  try {
    fs.rmSync(secretPath(), { force: true });
  } catch {
    // Nothing to clear.
  }
  chatHistory = [];
}

function defaultWindowPosition() {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  return constrainWindowPosition({
    x: Math.round(area.x + area.width - WINDOW_WIDTH - 12),
    y: Math.round(area.y + area.height - WINDOW_HEIGHT - 8),
  }, display);
}

function constrainWindowPosition(position, display, scale = settings.scale) {
  const area = display.workArea;
  const petLeft = WINDOW_WIDTH - 1 - PET_BASE_WIDTH;
  const petVisibleEdge = petLeft + PET_BASE_WIDTH * PET_TRANSFORM_ORIGIN_X
    + PET_BASE_WIDTH * (PET_VISIBLE_FRACTION - PET_TRANSFORM_ORIGIN_X) * Number(scale || 1);
  const minX = area.x - CHAT_PANEL.left;
  const maxX = Math.max(minX, Math.floor(area.x + area.width - petVisibleEdge - PET_EDGE_MARGIN));
  const minY = area.y - CHAT_PANEL.top;
  const maxY = Math.max(minY, area.y + area.height - (WINDOW_HEIGHT - WINDOW_BOTTOM_OVERFLOW));
  return {
    x: Math.round(Math.min(maxX, Math.max(minX, position.x))),
    y: Math.round(Math.min(maxY, Math.max(minY, position.y))),
  };
}

function restoreWindowPosition() {
  const saved = settings.windowPosition;
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) {
    return defaultWindowPosition();
  }
  const visible = screen.getAllDisplays().some(({ workArea }) => {
    const overlapX = saved.x < workArea.x + workArea.width && saved.x + WINDOW_WIDTH > workArea.x;
    const overlapY = saved.y < workArea.y + workArea.height && saved.y + WINDOW_HEIGHT > workArea.y;
    return overlapX && overlapY;
  });
  if (!visible) return defaultWindowPosition();
  const display = screen.getDisplayNearestPoint({
    x: Math.round(saved.x + WINDOW_WIDTH / 2),
    y: Math.round(saved.y + WINDOW_HEIGHT / 2),
  });
  return constrainWindowPosition(saved, display);
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  const position = restoreWindowPosition();
  settings.windowPosition = position;
  persistSettings();
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x: position.x,
    y: position.y,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const screenshotPath = process.env.QINGYU_SCREENSHOT_PATH;
  mainWindow.loadFile(path.join(__dirname, 'index.html'), screenshotPath ? {
    query: {
      preview: '1',
      layout: process.env.QINGYU_CHAT_LAYOUT || '',
      pose: process.env.QINGYU_PET_POSE || '',
    },
  } : undefined);

  mainWindow.once('ready-to-show', () => {
    mainWindow.showInactive();
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
    if (screenshotPath) {
      setTimeout(() => {
        const screenshotMode = process.env.QINGYU_SCREENSHOT_MODE;
        const channel = screenshotMode === 'settings'
          ? 'open-settings'
          : screenshotMode === 'context'
            ? 'open-context-preview'
            : 'open-chat';
        sendToRenderer(channel);
        setTimeout(async () => {
          const image = await mainWindow.webContents.capturePage();
          fs.writeFileSync(screenshotPath, image.toPNG());
          quitting = true;
          app.quit();
        }, 900);
      }, 600);
    }
  });

  mainWindow.on('move', () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const [x, y] = mainWindow.getPosition();
      settings.windowPosition = { x, y };
      persistSettings();
    }, 350);
  });

  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const source = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'character.png'))
    .crop({ x: 310, y: 65, width: 350, height: 350 });
  tray = new Tray(source.resize({ width: 32, height: 32, quality: 'best' }));
  tray.setToolTip('鲸鱼娘');
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打开聊天',
      click: () => {
        mainWindow.showInactive();
        sendToRenderer('open-chat');
      },
    },
    { label: '查看天气', click: () => sendToRenderer('request-weather') },
    { label: '设置', click: () => sendToRenderer('open-settings') },
    { type: 'separator' },
    {
      label: '显示 / 隐藏',
      click: () => (mainWindow.isVisible() ? mainWindow.hide() : mainWindow.showInactive()),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (!mainWindow.isVisible()) mainWindow.showInactive();
    sendToRenderer('open-chat');
  });
}

function normalizeSettings(next = {}, base = settings) {
  const source = { ...base, ...next };
  const allowedEfforts = new Set(['none', 'low', 'medium', 'high']);
  const allowedLayouts = new Set(['compact', 'standard', 'wide']);
  const bounded = (key, min, max) => {
    const value = Number(source[key]);
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : DEFAULT_SETTINGS[key]));
  };
  const boolean = (key) => typeof source[key] === 'boolean' ? source[key] : DEFAULT_SETTINGS[key];
  const clean = {
    petName: String(source.petName || DEFAULT_SETTINGS.petName).trim().slice(0, 16) || DEFAULT_SETTINGS.petName,
    city: String(source.city || DEFAULT_SETTINGS.city).trim().slice(0, 64) || DEFAULT_SETTINGS.city,
    reasoningEffort: allowedEfforts.has(source.reasoningEffort) ? source.reasoningEffort : 'medium',
    proactiveEnabled: boolean('proactiveEnabled'),
    voiceEnabled: boolean('voiceEnabled'),
    quietStart: Math.round(bounded('quietStart', 0, 23)),
    quietEnd: Math.round(bounded('quietEnd', 0, 23)),
    scale: bounded('scale', 0.78, 1.18),
    chatLayout: allowedLayouts.has(source.chatLayout) ? source.chatLayout : 'standard',
    alwaysOnTop: boolean('alwaysOnTop'),
    launchAtLogin: boolean('launchAtLogin'),
    conversationDirectory: normalizeConversationDirectory(source.conversationDirectory),
  };
  for (const key of ['petOpacity', 'chatOpacity', 'messageOpacity', 'inputOpacity', 'textOpacity', 'bubbleOpacity']) {
    clean[key] = Math.round(bounded(key, 0, 100));
  }
  if (Number.isFinite(source.windowPosition?.x) && Number.isFinite(source.windowPosition?.y)) {
    clean.windowPosition = { x: Math.round(source.windowPosition.x), y: Math.round(source.windowPosition.y) };
  }
  return clean;
}

function weatherLabel(code) {
  if (code === 0) return '晴朗';
  if ([1, 2].includes(code)) return '晴间多云';
  if (code === 3) return '阴天';
  if ([45, 48].includes(code)) return '有雾';
  if ([51, 53, 55, 56, 57].includes(code)) return '毛毛雨';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return '有雨';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return '有雪';
  if ([95, 96, 99].includes(code)) return '雷雨';
  return '天气多变';
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'WhaleGirl/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`网络请求失败（${response.status}）`);
  return response.json();
}

async function getWeather(force = false) {
  const city = settings.city;
  if (!force && weatherCache && weatherCache.city === city && Date.now() - weatherCache.at < 15 * 60 * 1000) {
    return weatherCache.data;
  }
  const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
  const geocode = await fetchJson(geocodeUrl);
  const location = geocode.results?.[0];
  if (!location) throw new Error(`没有找到“${city}”，请在设置里换一个城市名。`);

  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=1&timezone=auto`;
  const forecast = await fetchJson(weatherUrl);
  const current = forecast.current || {};
  const daily = forecast.daily || {};
  const data = {
    city: location.name,
    region: location.admin1 || location.country || '',
    condition: weatherLabel(current.weather_code),
    temperature: Math.round(current.temperature_2m),
    feelsLike: Math.round(current.apparent_temperature),
    high: Math.round(daily.temperature_2m_max?.[0]),
    low: Math.round(daily.temperature_2m_min?.[0]),
    rainChance: Math.round(daily.precipitation_probability_max?.[0] || 0),
    wind: Math.round(current.wind_speed_10m || 0),
    fetchedAt: Date.now(),
  };
  weatherCache = { city, at: Date.now(), data };
  return data;
}

function extractResponseText(data) {
  const chunks = [];
  for (const item of data.output || []) {
    if (item.type !== 'message') continue;
    for (const part of item.content || []) {
      if (part.type === 'output_text' && part.text) chunks.push(part.text);
    }
  }
  return chunks.join('\n').trim();
}

async function chatWithDeepSeek(message) {
  const apiKey = getApiKey();
  if (!apiKey) {
    const error = new Error('请先在设置中填写 DeepSeek API Key，之后就能直接在这个小窗口里连续聊天。');
    error.code = 'NO_API_KEY';
    throw error;
  }

  const now = new Date();
  const weatherContext = weatherCache?.data
    ? `当前天气：${weatherCache.data.city} ${weatherCache.data.condition} ${weatherCache.data.temperature}℃。`
    : '当前天气尚未获取。';
  const systemMessage = [
    `你是用户桌面上的陪伴角色“${settings.petName}”。`,
    '默认使用简体中文，语气温暖、自然、有分寸，像熟悉的朋友。',
    '根据问题需要决定回答长度；需要详细说明时完整回答，不设置人为字数上限。',
    '你可以陪聊、鼓励、提醒休息，也要诚实说明自己是 AI，不假装真人。',
    '当问题涉及新闻、最新资料、网页内容或可能变化的信息时，主动使用 web_search 后再回答。',
    `当前本地时间：${now.toLocaleString('zh-CN')}。${weatherContext}`,
  ].join('\n');
  const userMessage = { role: 'user', content: String(message).slice(0, 8000) };
  const body = {
    model: MODEL,
    instructions: systemMessage,
    input: [...chatHistory, userMessage],
    reasoning: { effort: settings.reasoningEffort || 'medium' },
    tools: [{ type: 'web_search' }],
    tool_choice: 'auto',
    stream: false,
  };

  const response = await fetch('https://api.deepseek.com/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const apiMessage = data.error?.message || `DeepSeek 请求失败（${response.status}）`;
    throw new Error(apiMessage);
  }
  const text = extractResponseText(data);
  if (!text) throw new Error('这次没有收到可显示的回复，请再试一次。');
  chatHistory.push(userMessage, { role: 'assistant', content: text });
  if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
  return { text, model: data.model || MODEL };
}

function formatWeatherReply(weather) {
  const region = weather.region && weather.region !== weather.city ? ` · ${weather.region}` : '';
  return `${weather.city}${region}现在 ${weather.condition}，${weather.temperature}℃，体感 ${weather.feelsLike}℃。\n今天 ${weather.low}～${weather.high}℃，降水概率 ${weather.rainChance}%。`;
}

async function answerConversation(message) {
  const question = String(message || '').trim();
  if (!question) throw new Error('请先输入消息。');
  const askedAt = Date.now();
  const petName = settings.petName;
  const archive = conversationStore;
  let result;
  try {
    if (/天气|气温|温度|下雨|带伞/.test(question)) {
      result = { text: formatWeatherReply(await getWeather(true)), kind: 'weather' };
    } else if (/几点|时间|日期|星期|几号/.test(question)) {
      const now = new Date();
      const time = new Intl.DateTimeFormat('zh-CN', {
        month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit',
      }).format(now);
      result = { text: `现在是 ${time}。`, kind: 'time' };
    } else {
      result = { ...await chatWithDeepSeek(question), kind: 'model' };
    }
  } catch (error) {
    result = { error: error.message || '暂时没能连上聊天服务，请稍后再试。' };
  }
  try {
    await archive.appendExchange({
      question, answer: result.text || result.error, petName, askedAt, failed: Boolean(result.error),
    });
  } catch (error) {
    result.archiveError = `本次对话未能保存到 ${archive.filePath}（${error.code || error.message}）。请检查文件夹是否可写。`;
  }
  return result;
}

function publicSettings() {
  return {
    ...settings,
    apiKeySet: Boolean(getApiKey()),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    conversationFile: conversationStore.filePath,
  };
}

function registerIpc() {
  ipcMain.handle('settings:get', () => publicSettings());

  ipcMain.handle('settings:save', (_event, next) => {
    const pending = settingsSaveQueue.then(async () => {
      const clean = normalizeSettings(next);
      const nextStore = clean.conversationDirectory === conversationStore.directory
        ? conversationStore : createConversationStore(clean.conversationDirectory);
      try {
        await nextStore.ensureWritable();
      } catch {
        throw new Error('无法保存到这个文件夹，请选择可写入的目录。');
      }
      if (settings.windowPosition) clean.windowPosition = settings.windowPosition;
      let adjustedPosition;
      if (clean.scale !== settings.scale && mainWindow && !mainWindow.isDestroyed()) {
        const bounds = mainWindow.getBounds();
        const display = screen.getDisplayNearestPoint({
          x: Math.round(bounds.x + bounds.width / 2),
          y: Math.round(bounds.y + bounds.height / 2),
        });
        adjustedPosition = constrainWindowPosition(bounds, display, clean.scale);
        clean.windowPosition = adjustedPosition;
      }
      persistSettings(clean);
      if (next.apiKey) saveApiKey(next.apiKey);
      if (settings.city !== clean.city) weatherCache = null;
      settings = clean;
      conversationStore = nextStore;
      if (!PREVIEW_MODE) app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
      mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
      if (adjustedPosition) mainWindow.setPosition(adjustedPosition.x, adjustedPosition.y, false);
      chatHistory = [];
      return publicSettings();
    });
    settingsSaveQueue = pending.catch(() => {});
    return pending;
  });

  ipcMain.handle('settings:clear-key', () => {
    clearApiKey();
    return true;
  });

  ipcMain.handle('ui:set-chat-layout', (_event, layout) => {
    const allowedLayouts = new Set(['compact', 'standard', 'wide']);
    settings.chatLayout = allowedLayouts.has(layout) ? layout : 'standard';
    persistSettings();
    return settings.chatLayout;
  });

  ipcMain.handle('weather:get', (_event, force) => getWeather(Boolean(force)));
  ipcMain.handle('chat:send', (_event, message) => answerConversation(message));
  ipcMain.handle('chat:clear', () => {
    chatHistory = [];
    return true;
  });

  ipcMain.on('window:set-ignore-mouse', (_event, ignore) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
    }
  });

  ipcMain.on('window:move-by', (_event, delta) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const bounds = mainWindow.getBounds();
    const targetDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const next = constrainWindowPosition({
      x: bounds.x + Math.round(delta.x),
      y: bounds.y + Math.round(delta.y),
    }, targetDisplay);
    mainWindow.setPosition(next.x, next.y, false);
  });

  ipcMain.handle('external:open-api-keys', () => shell.openExternal('https://platform.deepseek.com/api_keys'));
  ipcMain.handle('conversation:choose-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择对话保存目录',
      defaultPath: conversationStore.directory,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle('conversation:open-folder', async () => {
    await fs.promises.mkdir(conversationStore.directory, { recursive: true });
    const error = await shell.openPath(conversationStore.directory);
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.on('app:hide', () => mainWindow.hide());
  ipcMain.on('app:quit', () => {
    quitting = true;
    app.quit();
  });
}

configureUserData();

app.whenReady().then(() => {
  loadSettings();
  conversationStore.initialize().catch(() => {
    // Every subsequent exchange retries, and reports any remaining write failure in the chat.
  });
  registerIpc();
  createWindow();
  if (!PREVIEW_MODE) createTray();
  app.on('activate', () => {
    if (!mainWindow.isVisible()) mainWindow.showInactive();
  });
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('before-quit', () => {
  quitting = true;
});
