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

test('at least half of the transformed pet remains visible with animation margin at every allowed scale', async (t) => {
  const { constrain } = await mainHarness(t);
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  for (const scale of [0.78, 1, 1.18]) {
    const position = constrain({ x: 100000, y: 200 }, { workArea }, scale);
    const unscaledLeft = 376;
    const origin = unscaledLeft + 403 * 0.55;
    const scaledLeft = origin - 403 * 0.55 * scale;
    const scaledWidth = 403 * scale;
    const visibleWidth = workArea.width - (position.x + scaledLeft);
    assert.ok(visibleWidth >= scaledWidth / 2 + 10, `half of pet plus breathing margin must remain at scale ${scale}`);
    assert.ok(visibleWidth < scaledWidth / 2 + 11, 'whole-pixel clamping must allow dragging up to the safe limit');
  }
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
