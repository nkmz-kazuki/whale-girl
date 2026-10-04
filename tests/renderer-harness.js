const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function rendererHarness(options = {}) {
  let now = options.startAt ?? new Date(2026, 9, 4, 12).getTime();
  let nextTimer = 1;
  const timers = new Map();
  const bubbleChanges = [];
  const queriedSelectors = [];
  const missingSelectors = [];
  const elements = [];
  const ids = new Map();
  const bridgeEvents = new Map();
  const calls = { saveSettings: [], sendChat: [], moveBy: [], setIgnoreMouse: [], chooseDirectory: 0 };
  const opacityDefaults = { petOpacity: 100, chatOpacity: 80, messageOpacity: 88, inputOpacity: 92, textOpacity: 100, bubbleOpacity: 50 };
  let saved = {
    petName: '鲸鱼娘', city: '上海', reasoningEffort: 'medium', scale: 1,
    chatLayout: 'standard', proactiveEnabled: true, voiceEnabled: false,
    quietStart: 23, quietEnd: 8, alwaysOnTop: true, launchAtLogin: false,
    conversationDirectory: path.resolve('example-conversations'), ...opacityDefaults, ...options.settings,
  };
  function schedule(callback, delay, interval = 0) {
    const id = nextTimer++;
    timers.set(id, { callback, at: now + Number(delay), interval });
    return id;
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  class Element {
    constructor(tagName = 'div', attrs = {}) {
      this.tagName = tagName.toUpperCase();
      this.attrs = attrs;
      this.listeners = new Map();
      this.children = [];
      this.dataset = {};
      this.value = attrs.value || '';
      this.checked = false;
      this.disabled = false;
      this.complete = false;
      this.scrollHeight = 100;
      this.offsetWidth = 400;
      this._text = '';
      this._className = attrs.class || '';
      this.id = attrs.id || '';
      if (this.id) ids.set(this.id, this);
      for (const [key, value] of Object.entries(attrs)) {
        if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      }
      this.classList = {
        contains: (value) => this._className.split(/\s+/).includes(value),
        add: (...values) => { this._className = [...new Set([...this._className.split(/\s+/).filter(Boolean), ...values])].join(' '); },
        remove: (...values) => { this._className = this._className.split(/\s+/).filter((value) => !values.includes(value)).join(' '); },
        toggle: (value, enabled) => {
          const active = enabled ?? !this.classList.contains(value);
          this.classList[active ? 'add' : 'remove'](value);
          return active;
        },
      };
      const properties = new Map();
      this.style = { setProperty: (name, value) => properties.set(name, String(value)), getPropertyValue: (name) => properties.get(name) || '' };
      elements.push(this);
    }
    get className() { return this._className; }
    set className(value) { this._className = value; }
    get textContent() { return this._text; }
    set textContent(value) {
      this._text = String(value);
      if (this.id === 'bubbleText') bubbleChanges.push({ text: this._text, at: now });
    }
    addEventListener(name, listener) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(listener);
    }
    async dispatch(name, details = {}) {
      const event = { target: this, preventDefault() {}, ...details };
      await Promise.all((this.listeners.get(name) || []).map((listener) => listener(event)));
      await flush();
      return event;
    }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    remove() {
      this.removed = true;
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    }
    replaceChildren() { for (const child of this.children) child.remove(); this.children = []; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name]; }
    focus() { this.focused = true; }
    blur() { this.focused = false; }
    setPointerCapture() {}
    releasePointerCapture() {}
    getBoundingClientRect() { return { left: 0, top: 0, right: 400, bottom: 660, width: 400, height: 660 }; }
    closest(selector) {
      for (const alternative of selector.split(',')) {
        const classes = alternative.trim().split('.').filter(Boolean);
        if (classes.length && classes.every((name) => this.classList.contains(name))) return this;
      }
      return this.parentElement?.closest(selector) || null;
    }
    requestSubmit() { return this.dispatch('submit'); }
  }

  const html = await fs.readFile(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const attrs = {};
    for (const attr of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[attr[1]] = attr[2] ?? '';
    new Element(match[1], attrs);
  }
  const document = new Element('document');
  document.body = elements.find((element) => element.tagName === 'BODY');
  document.documentElement = elements.find((element) => element.tagName === 'HTML');
  document.querySelector = (selector) => {
    queriedSelectors.push(selector);
    const element = selector.startsWith('#')
      ? elements.findLast((candidate) => candidate.id === selector.slice(1) && !candidate.removed)
      : null;
    if (!element && selector !== '#typingMessage') missingSelectors.push(selector);
    return element || null;
  };
  document.querySelectorAll = (selector) => {
    queriedSelectors.push(selector);
    const match = selector.match(/^\[([^\]]+)\]$/);
    return match ? elements.filter((element) => match[1] in element.attrs && !element.removed) : [];
  };
  document.createElement = (name) => new Element(name);
  document.elementFromPoint = () => ids.get('petVisual');
  const api = {
    getSettings: async () => ({ ...saved }),
    saveSettings: async (next) => {
      calls.saveSettings.push({ ...next });
      if (options.saveError) throw new Error(options.saveError);
      saved = { ...saved, ...next };
      return { ...saved };
    },
    sendChat: async (text) => {
      calls.sendChat.push(text);
      return options.sendChat ? options.sendChat(text) : { text: '已回答。', kind: 'model' };
    },
    chooseConversationDirectory: async () => { calls.chooseDirectory += 1; return options.selectedDirectory ?? null; },
    setChatLayout: async (value) => value,
    setIgnoreMouse: (value) => calls.setIgnoreMouse.push(value),
    moveBy: (...values) => calls.moveBy.push(values),
    clearChat: async () => true,
    clearApiKey: async () => true,
    openApiKeys: async () => true,
    openConversationFolder: async () => true,
    hide() {}, quit() {},
  };
  for (const name of ['onOpenChat', 'onOpenSettings', 'onOpenContextPreview', 'onRequestWeather']) {
    api[name] = (handler) => bridgeEvents.set(name, handler);
  }
  const window = new Element('window');
  Object.assign(window, { petAPI: api, location: { search: '' }, innerWidth: 780, innerHeight: 720 });
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    window, document, Date: ClockDate, console, URLSearchParams,
    setTimeout: (callback, delay) => schedule(callback, delay),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, delay),
    clearInterval: (id) => timers.delete(id),
  });
  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'renderer.js' });
  await flush();
  return {
    get: (id) => ids.get(id),
    css: (name) => document.documentElement.style.getPropertyValue(name),
    get saved() { return saved; },
    get now() { return now; },
    calls, bubbleChanges, queriedSelectors, missingSelectors, html,
    openSettings: async () => { await bridgeEvents.get('onOpenSettings')(); await flush(); },
    openChat: async () => { await bridgeEvents.get('onOpenChat')(); await flush(); },
    flush,
    async advance(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        const next = [...timers.entries()].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        const [id, job] = next;
        now = job.at;
        if (job.interval) job.at += job.interval;
        else timers.delete(id);
        job.callback();
        await flush();
      }
      now = end;
      await flush();
    },
    async clickPet() {
      const event = { button: 0, pointerId: 1, screenX: 500, screenY: 300, clientX: 500, clientY: 300 };
      await ids.get('petVisual').dispatch('pointerdown', event);
      await ids.get('petVisual').dispatch('pointerup', event);
    },
    async send(text) {
      ids.get('chatInput').value = text;
      await ids.get('chatForm').dispatch('submit');
    },
  };
}

module.exports = { rendererHarness, deferred };
