import test from 'node:test';
import assert from 'node:assert/strict';
import { SleepGuard } from '../server/sleep-guard.js';

test('SleepGuard ref counting: acquire increments, release decrements', () => {
  const guard = new SleepGuard('darwin');

  assert.equal(guard.refs, 0);

  guard.acquire();
  assert.equal(guard.refs, 1);

  guard.acquire();
  assert.equal(guard.refs, 2);

  guard.release();
  assert.equal(guard.refs, 1);

  guard.release();
  assert.equal(guard.refs, 0);

  guard.dispose();
});

test('SleepGuard double-release does not go negative', () => {
  const guard = new SleepGuard('darwin');

  guard.acquire();
  guard.release();
  guard.release();

  assert.equal(guard.refs, 0);

  guard.dispose();
});

test('SleepGuard spawns caffeinate on darwin when acquiring', { skip: process.platform !== 'darwin' }, async () => {
  const guard = new SleepGuard('darwin');

  guard.acquire();
  assert.equal(guard.active, true, 'caffeinate should be running after acquire');

  guard.release();
  // Give the process a moment to die
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(guard.active, false, 'caffeinate should stop after final release');
  assert.equal(guard.refs, 0);
});

test('SleepGuard keeps caffeinate alive across multiple acquires on darwin', { skip: process.platform !== 'darwin' }, async () => {
  const guard = new SleepGuard('darwin');

  guard.acquire();
  guard.acquire();
  assert.equal(guard.active, true);

  guard.release();
  assert.equal(guard.active, true, 'caffeinate should stay alive with refs remaining');
  assert.equal(guard.refs, 1);

  guard.release();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(guard.active, false);

  guard.dispose();
});

test('SleepGuard dispose kills caffeinate and resets refs', { skip: process.platform !== 'darwin' }, async () => {
  const guard = new SleepGuard('darwin');

  guard.acquire();
  guard.acquire();
  assert.equal(guard.active, true);

  guard.dispose();
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(guard.refs, 0);
  assert.equal(guard.active, false);
});

test('SleepGuard is a no-op on non-darwin platforms', () => {
  const guard = new SleepGuard('linux');

  guard.acquire();
  assert.equal(guard.refs, 1);
  assert.equal(guard.active, false, 'should not spawn caffeinate on linux');

  guard.release();
  assert.equal(guard.refs, 0);

  guard.dispose();
});
