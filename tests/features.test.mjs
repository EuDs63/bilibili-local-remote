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
