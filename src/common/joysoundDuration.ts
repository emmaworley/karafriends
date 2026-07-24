// Reads the song duration out of a Joysound joy_02 telop blob. This lives in
// its own module -- free of the parser's heavy Kuroshiro / dictionary imports
// -- so it can be unit-tested under Node's test runner.

export function getSongDuration(telop: Uint8Array): number {
  // `telop` is often a view into a larger, pool-backed ArrayBuffer: Node reuses
  // a shared ~8 KiB pool for small Buffers (e.g. the result of
  // `Buffer.from(str, "base64")`), so `telop.byteOffset` can be non-zero and
  // `telop.buffer` can hold unrelated bytes before and after the telop. Index
  // from byteOffset -- reading from the start of the underlying buffer would
  // pull the offsets below out of pool garbage and yield a wild metadataOffset,
  // whose out-of-bounds DataView then crashes the process.
  const buffer = telop.buffer;
  const base = telop.byteOffset;
  const end = base + telop.byteLength;

  if (telop.byteLength < 10) {
    throw new Error(`Joysound telop is too small: ${telop.byteLength} bytes`);
  }

  const metadataOffset = new DataView(buffer, base + 6, 4).getUint32(0, true);
  if (base + metadataOffset + 20 > end) {
    throw new Error(
      `Joysound telop metadata offset ${metadataOffset} is out of bounds ` +
        `(telop is ${telop.byteLength} bytes)`,
    );
  }

  return new DataView(buffer, base + metadataOffset, 20).getUint16(18, true);
}
