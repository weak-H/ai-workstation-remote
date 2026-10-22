import assert from "node:assert/strict";
import test from "node:test";

import { CommandReplayGuard } from "./command-replay.js";

test("bounds replay nonces and expires them with their commands", () => {
  const guard = new CommandReplayGuard(2);
  const future = new Date(10_000).toISOString();

  assert.equal(guard.accept("nonce_1", future, 1_000), true);
  assert.equal(guard.accept("nonce_1", future, 1_000), false);
  assert.equal(guard.accept("nonce_2", future, 1_000), true);
  assert.equal(guard.accept("nonce_3", future, 1_000), false);
  assert.equal(guard.size, 2);
  assert.equal(guard.accept("nonce_1", future, 1_000), false);

  assert.equal(guard.accept("nonce_4", new Date(20_000).toISOString(), 10_000), true);
  assert.equal(guard.size, 1);
});
