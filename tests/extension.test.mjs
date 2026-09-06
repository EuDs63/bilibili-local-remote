import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const backgroundSource = fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

function eventStub() { return { addListener() {} }; }

function loadBackground({ tabs = [], groups = [], tabsGet, tabsRemove, sendMessage, fetchImpl, stored = {}, onStore } = {}) {
  const chrome = {
    tabs: {
      query: async () => tabs,
      get: tabsGet || (async (id) => tabs.find((tab) => tab.id === id)),
      sendMessage: sendMessage || (async () => ({ handled: true })),
      update: async () => {},
      create: async () => ({ id: 99 }),
      remove: tabsRemove || (async () => {}),
      onRemoved: eventStub(),
    },
    windows: { update: async () => {} },
    debugger: { attach: async () => { throw new Error("disabled"); }, detach: async () => {}, sendCommand: async () => ({}) },
    storage: { local: {
      get: async (key) => ({ [key]: stored[key] }),
      set: async (value) => { Object.assign(stored, structuredClone(value)); onStore?.(structuredClone(value)); },
    } },
    tabGroups: { query: async () => groups },
  };
  const context = {
    chrome,
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ ok: true }) })),
    structuredClone,
    setTimeout,
    clearTimeout,
    console,
    URL,
    TextEncoder,
    __EXTENSION_TEST__: true,
  };
  context.globalThis = context;
  vm.runInNewContext(`${backgroundSource}\nglobalThis.__hooks = { commandKey, compactJournal, processCommand, considerTarget, players, dispatch, loadJournal, reconcileJournal, loadControlTarget, buildCatalog, seekOpenedVideo };`, context, { filename: "background.js" });
  context.__hooks.__chrome = chrome;
  return context.__hooks;
}

test("an outcome whose acknowledgement was lost is posted again without executing twice", async () => {
  let executions = 0, posts = 0;
  const api = loadBackground({
    tabs: [{ id: 1, active: true, audible: true }],
    sendMessage: async (_id, message) => {
      if (message.kind === "player-probe") return { state: { paused: false } };
      executions += 1; return { handled: true };
    },
    fetchImpl: async (_url, options) => {
      if (options?.method === "POST") { posts += 1; if (posts === 1) throw new Error("ack lost"); }
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  const journal = { cursorByBoot: { bootA: 0 }, entries: {} };
  await assert.rejects(api.processCommand(journal, "bootA", { seq: 1, type: "toggle" }), /ack lost/);
  assert.equal(journal.entries["bootA:1"].status, "done");
  await api.processCommand(journal, "bootA", { seq: 1, type: "toggle" });
  assert.equal(executions, 1);
  assert.equal(posts, 2);
  assert.equal(journal.cursorByBoot.bootA, 1);
});

test("worker restart converts an ambiguous executing marker to failure without replay", async () => {
  let executions = 0; let posted;
  const api = loadBackground({
    sendMessage: async () => { executions += 1; return { handled: true }; },
    fetchImpl: async (_url, options) => {
      if (options?.body) posted = JSON.parse(options.body);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  const journal = { cursorByBoot: { bootA: 0 }, entries: { "bootA:7": { status: "executing" } } };
  await api.processCommand(journal, "bootA", { seq: 7, type: "seekBy", value: 30 });
  assert.equal(executions, 0);
  assert.equal(posted.bootId, "bootA");
  assert.equal(posted.seq, 7);
  assert.equal(posted.handled, false);
  assert.match(posted.detail, /避免重复操作/);
});

test("a selected target failure never falls through to another video tab", async () => {
  const calls = [];
  const api = loadBackground({
    tabs: [{ id: 1, active: true }, { id: 2, audible: true }],
    sendMessage: async (id, message) => {
      calls.push([id, message.kind]);
      if (message.kind === "player-probe") return { state: { paused: id !== 2 } };
      return { handled: false, detail: "unsupported" };
    },
  });
  api.considerTarget({ id: 1, active: true }, { paused: false });
  const result = await api.dispatch({ type: "next" });
  assert.equal(result.handled, false);
  assert.deepEqual(calls, [[1, "remote-command"]]);
});

test("two audible players do not oscillate, while active playback can replace a paused target", () => {
  const api = loadBackground();
  assert.equal(api.considerTarget({ id: 1, active: true, audible: true }, { paused: false }), true);
  assert.equal(api.considerTarget({ id: 2, active: false, audible: true }, { paused: false }), false);
  assert.equal(api.considerTarget({ id: 1, active: false, audible: false }, { paused: true }), true);
  assert.equal(api.considerTarget({ id: 2, active: true, audible: true }, { paused: false }), true);
});

test("journal snapshots never store an openUrl command payload", async () => {
  const snapshots = [];
  const api = loadBackground({ onStore: (value) => snapshots.push(value) });
  const journal = { cursorByBoot: { bootA: 0 }, entries: {} };
  await api.processCommand(journal, "bootA", { seq: 1, type: "openUrl", value: "https://private.example/video" });
  assert.equal(snapshots.some((snapshot) => JSON.stringify(snapshot).includes("private.example")), false);
  assert.equal(api.commandKey("bootA", 1), "bootA:1");
});

test("storage write failure prevents command dispatch", async () => {
  let executions = 0;
  const api = loadBackground({ sendMessage: async () => { executions += 1; return { handled: true }; } });
  api.__chrome.storage.local.set = async () => { throw new Error("storage unavailable"); };
  const journal = { cursorByBoot: { bootA: 0 }, entries: {} };
  await assert.rejects(api.processCommand(journal, "bootA", { seq: 1, type: "toggle" }), /storage unavailable/);
  assert.equal(executions, 0);
});

test("storage read failure does not fabricate an empty journal", async () => {
  const api = loadBackground();
  api.__chrome.storage.local.get = async () => { throw new Error("storage unavailable"); };
  await assert.rejects(api.loadJournal(), /storage unavailable/);
});

test("server acknowledged entries are removed before capacity checks", () => {
  const api = loadBackground();
  const journal = {
    cursorByBoot: { bootA: 0 },
    entries: {
      "bootA:1": { status: "done", outcome: { handled: true, detail: "ok" } },
      "bootA:2": { status: "done", outcome: { handled: true, detail: "ok" } },
    },
  };
  assert.equal(api.reconcileJournal(journal, "bootA", 1), 1);
  assert.equal(journal.entries["bootA:1"], undefined);
  assert.ok(journal.entries["bootA:2"]);
});

test("manual lock survives worker reload and ignores competing audible tabs", async () => {
  const stored = {};
  const tabs = [
    { id: 1, active: true, audible: false },
    { id: 2, active: false, audible: true },
  ];
  const sendMessage = async (id, message) => message.kind === "player-probe"
    ? { state: { title: `tab ${id}`, siteName: "test", url: `https://test/${id}`, paused: false } }
    : { handled: true };
  let api = loadBackground({ tabs, sendMessage, stored });
  assert.equal((await api.dispatch({ type: "lockTab", value: 1 })).handled, true);
  api = loadBackground({ tabs, sendMessage, stored });
  await api.loadControlTarget();
  assert.equal(api.considerTarget(tabs[1], { paused: false }), false);
  assert.equal(api.considerTarget(tabs[0], { paused: false }), true);
});

test("closing a locked tab releases the persisted lock", async () => {
  const stored = {};
  const tabs = [{ id: 4, active: true }];
  const api = loadBackground({
    tabs,
    stored,
    sendMessage: async () => ({ state: { title: "four", siteName: "test", url: "https://test/4", paused: true } }),
  });
  await api.dispatch({ type: "lockTab", value: 4 });
  await api.dispatch({ type: "closeTab" });
  assert.equal(stored.remoteControlTargetV1.lockedTabId, null);
});

test("explicit tab selection moves an existing manual lock", async () => {
  const stored = {};
  const tabs = [{ id: 1, active: true }, { id: 2, active: false }];
  const api = loadBackground({
    tabs,
    stored,
    sendMessage: async (id) => ({
      state: { title: `tab ${id}`, siteName: "test", url: `https://test/${id}`, paused: true },
    }),
  });
  await api.dispatch({ type: "lockTab", value: 1 });
  await api.dispatch({ type: "selectTab", value: 2 });
  assert.equal(stored.remoteControlTargetV1.lockedTabId, 2);
  assert.equal((await api.buildCatalog()).selectedTabId, 2);
});

test("catalog contains every browser tab in browser order with video enrichment", async () => {
  const tabs = [
    { id: 8, windowId: 2, index: 0, title: "Settings", url: "edge://settings", active: true, groupId: -1 },
    { id: 1, windowId: 1, index: 3, title: "Video", url: "https://a/1", active: false, groupId: 0 },
    { id: 9, windowId: 2, index: 1, title: "File", url: "file:///tmp/test", active: false, groupId: -1 },
  ];
  const api = loadBackground({ tabs, groups: [{ id: 0, windowId: 1, title: "Work", color: "blue", collapsed: true }] });
  api.considerTarget({ id: 1, active: true, incognito: false }, { title: "one", siteName: "a", url: "https://a/1", paused: false });
  const catalog = await api.buildCatalog();
  assert.deepEqual(Array.from(catalog.tabs, (tab) => tab.id), [8, 1, 9]);
  assert.equal(catalog.selectedTabId, 1);
  assert.equal(catalog.supportsCloseTabById, true);
  assert.equal(catalog.tabs[0].hasVideo, false);
  assert.equal(catalog.tabs[1].hasVideo, true);
  assert.deepEqual({ ...catalog.tabs[1].group }, { id: 0, title: "Work", color: "blue", collapsed: true });
  assert.equal(catalog.tabs[2].group, null);
});

test("selecting a non-video browser tab preserves the video target and lock", async () => {
  const stored = {};
  const tabs = [
    { id: 1, windowId: 1, index: 0, url: "https://video.test", active: false },
    { id: 2, windowId: 1, index: 1, url: "edge://settings", active: true },
  ];
  const api = loadBackground({
    tabs,
    stored,
    sendMessage: async (id, message) => message.kind === "player-probe" && id === 1
      ? { state: { title: "video", siteName: "test", url: tabs[0].url, paused: true } }
      : null,
  });
  await api.dispatch({ type: "lockTab", value: 1 });
  const result = await api.dispatch({ type: "selectTab", value: 2 });
  assert.equal(result.handled, true);
  assert.equal(stored.remoteControlTargetV1.lockedTabId, 1);
  assert.equal((await api.buildCatalog()).selectedTabId, 1);
});

test("catalog does not truncate merely because there are more than 100 tabs", async () => {
  const tabs = Array.from({ length: 150 }, (_, index) => ({
    id: index + 1,
    windowId: index < 75 ? 1 : 2,
    index: index % 75,
    title: `tab ${index + 1}`,
    url: index % 2 ? `about:blank#${index}` : `chrome://newtab/#${index}`,
    groupId: -1,
  }));
  const catalog = await loadBackground({ tabs }).buildCatalog();
  assert.equal(catalog.tabs.length, 150);
  assert.equal(catalog.totalTabCount, 150);
  assert.equal(catalog.truncated, false);
});

test("catalog refresh reflects group changes and keeps fallback metadata", async () => {
  const groups = [{ id: 0, title: "Before", color: "red", collapsed: false }];
  const tabs = [
    { id: 1, windowId: 1, index: 0, title: "one", url: "about:blank", groupId: 0 },
    { id: 2, windowId: 1, index: 1, title: "two", url: "about:blank", groupId: 9 },
  ];
  const api = loadBackground({ tabs, groups });
  let catalog = await api.buildCatalog();
  assert.equal(catalog.tabs[0].group.title, "Before");
  groups[0].title = "After";
  groups[0].color = "cyan";
  catalog = await api.buildCatalog();
  assert.equal(catalog.tabs[0].group.title, "After");
  assert.equal(catalog.tabs[0].group.color, "cyan");
  assert.deepEqual(
    { ...catalog.tabs[1].group },
    { id: 9, title: "未命名分组", color: "grey", collapsed: false },
  );
});

test("catalog clears target ids when a closing tab is absent from the browser snapshot", async () => {
  const api = loadBackground({ tabs: [] });
  api.considerTarget(
    { id: 77, active: true },
    { title: "closing", siteName: "test", url: "https://test/closing", paused: true },
  );
  const catalog = await api.buildCatalog();
  assert.equal(catalog.tabs.length, 0);
  assert.equal(catalog.selectedTabId, null);
  assert.equal(catalog.lockedTabId, null);
});

test("catalog clears a target id if its tab cannot fit the byte budget", async () => {
  const hugeUrl = `data:text/plain,${"x".repeat(3_900_100)}`;
  const tabs = [{ id: 5, windowId: 1, index: 0, title: "huge", url: hugeUrl, groupId: -1 }];
  const api = loadBackground({ tabs });
  api.considerTarget(
    { ...tabs[0], active: true },
    { title: "huge", siteName: "data", url: hugeUrl, paused: true },
  );
  const catalog = await api.buildCatalog();
  assert.equal(catalog.truncated, true);
  assert.equal(catalog.tabs.length, 0);
  assert.equal(catalog.selectedTabId, null);
});

test("resume never seeks the old document after navigation starts", async () => {
  let reads = 0;
  const messages = [];
  const api = loadBackground({
    tabsGet: async () => {
      reads += 1;
      return reads === 1
        ? { url: "https://old.test/video", pendingUrl: "https://new.test/video", status: "loading" }
        : { url: "https://new.test/video", status: "complete" };
    },
    sendMessage: async (_id, message) => { messages.push(message); return { handled: true }; },
  });
  await api.seekOpenedVideo(1, "https://new.test/video", 42);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].command.value.url, "https://new.test/video");
});

test("explicit close removes an ordinary tab when there is no video player", async () => {
  const removed = [];
  const tabs = [{ id: 20, windowId: 1, index: 0, url: "edge://settings" }];
  const api = loadBackground({ tabs, tabsRemove: async (id) => removed.push(id) });
  const result = await api.dispatch({ type: "closeTab", value: 20 });
  assert.equal(result.handled, true);
  assert.deepEqual(removed, [20]);
});

test("explicit close of another tab preserves the selected video and lock", async () => {
  const stored = {};
  const tabs = [
    { id: 1, windowId: 1, index: 0, url: "https://video.test" },
    { id: 2, windowId: 1, index: 1, url: "about:blank" },
  ];
  const api = loadBackground({
    tabs,
    stored,
    sendMessage: async (id, message) => message.kind === "player-probe" && id === 1
      ? { state: { title: "video", siteName: "test", url: tabs[0].url, paused: true } }
      : null,
  });
  await api.dispatch({ type: "lockTab", value: 1 });
  await api.dispatch({ type: "closeTab", value: 2 });
  assert.equal(stored.remoteControlTargetV1.lockedTabId, 1);
  assert.equal((await api.buildCatalog()).selectedTabId, 1);
});

test("explicit close clears a selected locked target only after removal succeeds", async () => {
  const stored = {};
  let rejectRemoval = true;
  const tabs = [{ id: 7, windowId: 1, index: 0, url: "https://video.test" }];
  const api = loadBackground({
    tabs,
    stored,
    tabsRemove: async () => { if (rejectRemoval) throw new Error("cannot close"); },
    sendMessage: async () => ({
      state: { title: "video", siteName: "test", url: tabs[0].url, paused: true },
    }),
  });
  await api.dispatch({ type: "lockTab", value: 7 });
  await assert.rejects(api.dispatch({ type: "closeTab", value: 7 }), /cannot close/);
  assert.equal(stored.remoteControlTargetV1.lockedTabId, 7);
  rejectRemoval = false;
  const result = await api.dispatch({ type: "closeTab", value: 7 });
  assert.equal(result.handled, true);
  assert.equal(stored.remoteControlTargetV1.lockedTabId, null);
});

test("close without a tab id remains scoped to the current video target", async () => {
  const removed = [];
  const tabs = [
    { id: 3, windowId: 1, index: 0, url: "https://video.test" },
    { id: 4, windowId: 1, index: 1, url: "edge://settings" },
  ];
  const api = loadBackground({
    tabs,
    tabsRemove: async (id) => removed.push(id),
    sendMessage: async (id, message) => message.kind === "player-probe" && id === 3
      ? { state: { title: "video", siteName: "test", url: tabs[0].url, paused: true } }
      : null,
  });
  const result = await api.dispatch({ type: "closeTab" });
  assert.equal(result.handled, true);
  assert.deepEqual(removed, [3]);
});

test("an explicit invalid close id never falls back to the current video", async () => {
  const removed = [];
  const api = loadBackground({ tabsRemove: async (id) => removed.push(id) });
  const result = await api.dispatch({ type: "closeTab", value: null });
  assert.equal(result.handled, false);
  assert.deepEqual(removed, []);
});
