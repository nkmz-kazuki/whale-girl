const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { mainHarness } = require('./main-harness');

const layouts = [
  { left: 16, top: 29, width: 374, height: 654 },
  { left: 38, top: 146, width: 316, height: 500 },
  { left: 8, top: 29, width: 430, height: 654 },
];

test('all chat layouts stay inside the work area at each drag boundary on primary and offset monitors', async (t) => {
  const { constrain } = await mainHarness(t);
  for (const workArea of [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: -1920, y: 120, width: 1920, height: 1040 },
  ]) {
    for (const scale of [0.78, 1, 1.18]) {
      for (const position of [{ x: -100000, y: -100000 }, { x: 100000, y: 100000 }]) {
        const next = constrain(position, { workArea }, scale);
        for (const panel of layouts) {
          assert.ok(next.x + panel.left >= workArea.x, 'panel left must remain visible');
          assert.ok(next.x + panel.left + panel.width <= workArea.x + workArea.width, 'panel right must remain visible');
          assert.ok(next.y + panel.top >= workArea.y, 'panel top must remain visible');
          assert.ok(next.y + panel.top + panel.height <= workArea.y + workArea.height, 'panel bottom must remain visible');
        }
      }
    }
  }
});

test('seven eighths of the transformed pet remain visible with a four-DIP margin at every allowed scale', async (t) => {
  const { constrain } = await mainHarness(t);
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  for (const scale of [0.78, 1, 1.18]) {
    const position = constrain({ x: 100000, y: 200 }, { workArea }, scale);
    const unscaledLeft = 376;
    const origin = unscaledLeft + 403 * 0.55;
    const scaledLeft = origin - 403 * 0.55 * scale;
    const scaledWidth = 403 * scale;
    const visibleWidth = workArea.width - (position.x + scaledLeft);
    assert.ok(visibleWidth >= scaledWidth * 0.875 + 4, `seven eighths of pet plus margin must remain at scale ${scale}`);
    assert.ok(visibleWidth < scaledWidth * 0.875 + 5, 'whole-pixel clamping must allow dragging up to the safe limit');
  }
});

test('the screenshot work area clamps the small pet at x832/y246 and allows only six DIPs below the screen', async (t) => {
  const { constrain } = await mainHarness(t);
  const display = { workArea: { x: 0, y: 0, width: 1536, height: 960 } };
  const position = constrain({ x: 100000, y: 100000 }, display, 0.78);
  assert.equal(position.x, 832);
  assert.equal(position.y, 246);
  assert.equal(position.y + 720 - display.workArea.height, 6);
  const preserved = constrain({ x: 820, y: 230 }, display, 0.78);
  assert.equal(preserved.x, 820);
  assert.equal(preserved.y, 230);
});

test('incremental drag IPC reaches the right-bottom limit without accumulating movement beyond it', async (t) => {
  const display = { workArea: { x: 0, y: 0, width: 1536, height: 960 } };
  const harness = await mainHarness(t, {
    displays: [display], saved: { scale: 0.78 },
    windowBounds: { x: 830, y: 244, width: 780, height: 720 },
    cursorPoint: { x: 1450, y: 850 },
  });
  for (let index = 0; index < 20; index += 1) harness.emit('window:move-by', { x: 1, y: 1 });
  assert.equal(harness.windowBounds.x, 832);
  assert.equal(harness.windowBounds.y, 246);
  harness.emit('window:move-by', { x: -1, y: -1 });
  assert.equal(harness.windowBounds.x, 831);
  assert.equal(harness.windowBounds.y, 245);
});

test('startup restores and persists a corrected legacy position beyond the new screenshot limit', async (t) => {
  const display = { workArea: { x: 0, y: 0, width: 1536, height: 960 } };
  const harness = await mainHarness(t, {
    displays: [display], saved: { scale: 0.78, windowPosition: { x: 836, y: 280 } },
  });
  const restored = harness.restorePosition();
  assert.equal(restored.x, 832);
  assert.equal(restored.y, 246);
  harness.createWindow();
  assert.equal(harness.windowBounds.x, 832);
  assert.equal(harness.windowBounds.y, 246);
  const persisted = JSON.parse(await fs.readFile(path.join(harness.appPaths.userData, 'settings.json'), 'utf8'));
  assert.deepEqual(persisted.windowPosition, { x: 832, y: 246 });
});

test('default and disconnected-display startup positions use a valid primary-screen position', async (t) => {
  const display = { workArea: { x: 0, y: 0, width: 1536, height: 960 } };
  const harness = await mainHarness(t, { displays: [display], saved: { scale: 0.78 } });
  const initial = harness.defaultPosition();
  assert.equal(initial.x, 744);
  assert.equal(initial.y, 232);
  const restored = harness.restorePosition();
  assert.equal(restored.x, initial.x);
  assert.equal(restored.y, initial.y);
  const disconnected = await mainHarness(t, {
    displays: [display], saved: { scale: 0.78, windowPosition: { x: -5000, y: -5000 } },
  });
  const fallback = disconnected.restorePosition();
  assert.equal(fallback.x, 744);
  assert.equal(fallback.y, 232);
});

test('dragging and startup restore use the negative-coordinate secondary monitor work area', async (t) => {
  const primary = { workArea: { x: 0, y: 0, width: 1536, height: 960 } };
  const secondary = { workArea: { x: -1536, y: 100, width: 1536, height: 960 } };
  const harness = await mainHarness(t, {
    displays: [primary, secondary],
    saved: { scale: 0.78, windowPosition: { x: -700, y: 400 } },
    windowBounds: { x: -710, y: 344, width: 780, height: 720 },
    cursorPoint: { x: -100, y: 850 },
  });
  const restored = harness.restorePosition();
  assert.equal(restored.x, -704);
  assert.equal(restored.y, 346);
  harness.emit('window:move-by', { x: 1000, y: 1000 });
  assert.equal(harness.windowBounds.x, -704);
  assert.equal(harness.windowBounds.y, 346);
});

test('saving a changed character scale reclamps and persists the current position on its monitor', async (t) => {
  const display = { workArea: { x: -1920, y: 120, width: 1920, height: 1040 } };
  const harness = await mainHarness(t, {
    displays: [display], saved: { scale: 1.18 },
    windowBounds: { x: -585, y: 430, width: 780, height: 720 },
  });
  const saved = await harness.invoke('settings:save', { scale: 0.78 });
  assert.equal(harness.positionChanges.length, 1);
  const expected = harness.constrain({ x: -585, y: 430 }, display, 0.78);
  assert.equal(harness.windowBounds.x, expected.x);
  assert.equal(harness.windowBounds.y, expected.y);
  assert.equal(saved.windowPosition.x, expected.x);
  const persisted = JSON.parse(await fs.readFile(path.join(harness.appPaths.userData, 'settings.json'), 'utf8'));
  assert.equal(persisted.windowPosition.x, expected.x);
  assert.equal(persisted.scale, 0.78);
});

test('an invalid directory cannot move the window while attempting to change scale', async (t) => {
  const harness = await mainHarness(t);
  const previous = harness.windowBounds;
  await assert.rejects(harness.invoke('settings:save', { scale: 1.18, conversationDirectory: 'not-absolute' }));
  assert.deepEqual(harness.windowBounds, previous);
  assert.equal(harness.positionChanges.length, 0);
});
