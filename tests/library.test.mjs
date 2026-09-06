import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLibrary } from "../library.mjs";

test("library rejects queue overflow without discarding existing items", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "video-library-capacity-"));
  try {
    const library = createLibrary(dataDir, null);
    library.addQueue(Array.from({ length: 50 }, (_, index) => ({ url: `https://example.com/${index}` })));
    library.addQueue(Array.from({ length: 50 }, (_, index) => ({ url: `https://example.com/${index + 50}` })));
    assert.throws(() => library.addQueue([{ url: "https://example.com/overflow" }]), /最多保存 100 项/);
    assert.equal(library.snapshot().queue.length, 100);
    assert.equal(library.snapshot().queue[0].url, "https://example.com/0");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("library filters invalid persisted records and reports storage failures", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "video-library-validation-"));
  writeFileSync(join(dataDir, "library.json"), JSON.stringify({
    queue: [{ id: "valid", url: "https://example.com/ok", title: "保留" }, { id: "bad", url: "javascript:alert(1)" }],
    bookmarks: [{ id: "bad-time", url: "https://example.com/b", time: "never" }],
    history: "not-an-array",
  }));
  const library = createLibrary(dataDir, null);
  assert.equal(library.snapshot().queue.length, 1);
  assert.deepEqual(library.snapshot().bookmarks, []);

  rmSync(dataDir, { recursive: true, force: true });
  assert.throws(() => library.addBookmark({ url: "https://example.com/new", time: 1 }), /ENOENT/);
  assert.deepEqual(library.snapshot().bookmarks, []);
  mkdirSync(dataDir);
  rmSync(dataDir, { recursive: true, force: true });
});
