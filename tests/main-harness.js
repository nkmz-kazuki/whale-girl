const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const storeModule = require('../src/conversation-store');

async function mainHarness(t, { store, fetchImpl, saved, legacy, selectedDirectory,
  displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
  windowBounds = { x: 900, y: 200, width: 780, height: 720 },
} = {}) {
  const root = os.tmpdir();
  const directory = await fs.mkdtemp(path.join(root, 'whale-girl-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), root);
    assert.ok(path.basename(directory).startsWith('whale-girl-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const appPaths = {
    appData: directory,
    userData: path.join(directory, 'whale-girl'),
    documents: path.join(directory, 'Documents'),
    temp: directory,
  };
  for (const [name, data] of [['whale-girl', saved], ['qingyu-desktop-companion', legacy]]) {
    if (!data) continue;
    const target = path.join(directory, name);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'settings.json'), JSON.stringify(data));
    if (name === 'qingyu-desktop-companion') await fs.writeFile(path.join(target, 'deepseek-key.bin'), 'encrypted-test-fixture');
  }
  const handlers = new Map();
  const positionChanges = [];
  let bounds = { ...windowBounds };
  let loginUpdates = 0;
  const electron = {
    app: {
      whenReady: () => ({ then() {} }), on() {},
      getPath: (name) => appPaths[name],
      setPath: (name, value) => { appPaths[name] = value; },
      setLoginItemSettings() { loginUpdates += 1; },
    },
    dialog: { showOpenDialog: async () => ({ canceled: !selectedDirectory, filePaths: selectedDirectory ? [selectedDirectory] : [] }) },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
    safeStorage: { isEncryptionAvailable: () => false },
    screen: {
      getPrimaryDisplay: () => displays[0],
      getAllDisplays: () => displays,
      getDisplayNearestPoint: (point) => displays.find(({ workArea: area }) =>
        point.x >= area.x && point.x < area.x + area.width && point.y >= area.y && point.y < area.y + area.height) || displays[0],
    },
  };
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : name === './conversation-store'
      ? { ...storeModule, createConversationStore: store ? () => store : storeModule.createConversationStore } : require(name),
    __dirname: path.join(__dirname, '..', 'src'),
    process: { ...process, env: { ...process.env, QINGYU_SCREENSHOT_PATH: '' } },
    console, fetch: fetchImpl, AbortSignal, setTimeout, clearTimeout,
    testWindow: {
      setAlwaysOnTop() {},
      isDestroyed: () => false,
      getBounds: () => ({ ...bounds }),
      setPosition: (x, y) => { bounds = { ...bounds, x, y }; positionChanges.push({ x, y }); },
    },
  });
  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  vm.runInContext(source + '\nloadSettings(); sessionApiKey = "local-test-only"; mainWindow = testWindow; registerIpc();', context);
  return {
    invoke: (channel, value) => handlers.get(channel)({}, value),
    directory,
    appPaths,
    positionChanges,
    get windowBounds() { return { ...bounds }; },
    constrain: (position, display, scale) => context.constrainWindowPosition(position, display, scale),
    get loginUpdates() { return loginUpdates; },
  };
}

module.exports = { mainHarness };
