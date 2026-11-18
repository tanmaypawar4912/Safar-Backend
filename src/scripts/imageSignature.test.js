import test from "node:test";
import assert from "node:assert/strict";
import { matchesImageSignature } from "../middleware/validateImageSignature.js";

test("accepts matching JPEG signature", () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  assert.equal(matchesImageSignature(bytes, "image/jpeg"), true);
});

test("accepts matching PNG signature", () => {
  const bytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
  ]);
  assert.equal(matchesImageSignature(bytes, "image/png"), true);
});

test("accepts matching WEBP signature", () => {
  const bytes = Buffer.from("RIFF0000WEBP", "ascii");
  assert.equal(matchesImageSignature(bytes, "image/webp"), true);
});

test("rejects MIME spoofing when bytes do not match", () => {
  const bytes = Buffer.from("<html>not an image</html>", "ascii");
  assert.equal(matchesImageSignature(bytes, "image/jpeg"), false);
  assert.equal(matchesImageSignature(bytes, "image/png"), false);
  assert.equal(matchesImageSignature(bytes, "image/webp"), false);
});

test("rejects a valid image signature declared as a different MIME type", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  assert.equal(matchesImageSignature(jpeg, "image/png"), false);
});

test("rejects unsupported MIME types and non-buffer values", () => {
  assert.equal(matchesImageSignature(Buffer.from("x"), "application/pdf"), false);
  assert.equal(matchesImageSignature("not-a-buffer", "image/jpeg"), false);
});
