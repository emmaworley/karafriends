// This file runs on Node's built-in test runner, not through the app bundle, so
// it uses node: core modules directly.
/* tslint:disable:no-submodule-imports no-implicit-dependencies */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getSongDuration } from "./joysoundDuration.ts";

// Builds a minimal joy_02-shaped telop: a 4-byte metadata offset at byte 6
// pointing at a 20-byte metadata block whose last uint16 (byte 18) is the
// duration.
function buildTelop(duration: number, metadataOffset = 16): Uint8Array {
  const total = metadataOffset + 20;
  const telop = new Uint8Array(total);
  const view = new DataView(telop.buffer);
  view.setUint32(6, metadataOffset, true);
  view.setUint16(metadataOffset + 18, duration, true);
  return telop;
}

describe("getSongDuration", () => {
  test("reads the duration from a zero-offset telop", () => {
    assert.equal(getSongDuration(buildTelop(214)), 214);
  });

  // Regression test for the crash: a Buffer decoded from base64 is often a view
  // into a shared pool, so telop.byteOffset is non-zero and telop.buffer holds
  // unrelated bytes at offset 0. Reading from the buffer start (the old bug)
  // pulled a garbage metadata offset out of that pool and threw an
  // out-of-bounds DataView RangeError, crashing the main process.
  test("reads the duration from a pool-backed (non-zero byteOffset) view", () => {
    const telop = buildTelop(2600);
    // Simulate the pool: place the telop inside a larger buffer whose leading
    // bytes are garbage, then hand over just the telop sub-view.
    const pool = new Uint8Array(telop.length + 64).fill(0xff);
    pool.set(telop, 32);
    const view = pool.subarray(32, 32 + telop.length);
    assert.equal(view.byteOffset, 32);
    assert.equal(getSongDuration(view), 2600);
  });

  test("throws (does not crash) on a metadata offset past the end", () => {
    const telop = buildTelop(100);
    // Corrupt the offset field so it points well beyond the buffer.
    new DataView(telop.buffer).setUint32(6, 0x7f000000, true);
    assert.throws(() => getSongDuration(telop), /out of bounds/);
  });

  test("throws (does not crash) on a truncated telop", () => {
    assert.throws(() => getSongDuration(new Uint8Array(4)), /too small/);
  });
});
