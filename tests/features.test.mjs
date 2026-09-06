import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/features.js", import.meta.url), "utf8");
const context = { URL };
context.globalThis = context;
vm.runInNewContext(source, context);
const features = context.RemoteFeatures;

test("batch link parsing deduplicates, validates, and caps queue additions", () => {
  const text = [
    "分享 https://example.com/a。",
    "https://example.com/a",
    "https://user:secret@example.com/private",
    ...Array.from({ length: 60 }, (_, index) => `https://example.com/${index}`),
  ].join("\n");
  const items = features.extractUrls(text);
  assert.equal(items.length, 50);
  assert.equal(items[0].url, "https://example.com/a");
  assert.equal(items.some((item) => item.url.includes("private")), false);
});

test("queue movement is immutable and respects both boundaries", () => {
  const queue = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(features.moveItem(queue, "b", -1).map((item) => item.id), ["b", "a", "c"]);
  assert.deepEqual(features.moveItem(queue, "a", -1).map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(queue.map((item) => item.id), ["a", "b", "c"]);
});

test("bookmark captures the displayed player timestamp and optional note", () => {
  const bookmark = features.bookmarkFromPlayer({
    url: "https://example.com/video",
    title: "Episode 2",
    currentTime: 91.25,
  }, " favorite scene ");
  assert.deepEqual(
    JSON.parse(JSON.stringify(bookmark)),
    {
      url: "https://example.com/video",
      title: "Episode 2",
      time: 91.25,
      note: "favorite scene",
    },
  );
});

test("tab tree preserves windows, native order, group zero, and ungrouped runs", () => {
  const tabs = [
    { id: 4, windowId: 2, index: 1, group: { id: 0, title: "Work" } },
    { id: 1, windowId: 1, index: 0, group: null },
    { id: 3, windowId: 1, index: 2, group: null },
    { id: 2, windowId: 1, index: 1, group: { id: 7, title: "Work" } },
    { id: 5, windowId: 2, index: 0 },
  ];
  const tree = features.buildTabTree(tabs);
  assert.deepEqual(Array.from(tree, (window) => window.windowId), [1, 2]);
  assert.deepEqual(Array.from(tree[0].entries, (entry) => entry.key), ["ungrouped", "group:7", "ungrouped"]);
  assert.equal(tree[1].entries[1].key, "group:0");
  const ids = Array.from(tree, (window) => Array.from(
    window.entries,
    (entry) => Array.from(entry.tabs, (tab) => tab.id),
  )).flat(2);
  assert.deepEqual(ids, [1, 2, 3, 5, 4]);
});

function themeHarness(storage) {
  const root = { dataset: {}, style: {} };
  const meta = { content: "" };
  const controller = features.createThemeController({ storage, root, meta });
  return { controller, root, meta };
}

test("theme defaults to light and persists explicit toggles", () => {
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, value); },
  };
  const first = themeHarness(storage);
  assert.equal(first.controller.theme, "light");
  assert.equal(first.controller.toggle(), "dark");
  assert.equal(values.get("videoRemoteTheme"), "dark");
  const restored = themeHarness(storage);
  assert.equal(restored.controller.theme, "dark");
  assert.equal(restored.meta.content, "#141618");
});

test("invalid saved theme safely falls back to the light theme", () => {
  const result = themeHarness({
    getItem() { return "purple"; },
    setItem() {},
  });
  assert.equal(result.controller.theme, "light");
  assert.equal(result.root.style.colorScheme, "light");
  assert.equal(result.meta.content, "#e7e9ec");
});

test("theme remains usable when storage access fails", () => {
  const result = themeHarness({
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  });
  assert.equal(result.controller.theme, "light");
  assert.doesNotThrow(() => result.controller.toggle());
  assert.equal(result.controller.theme, "dark");
});
