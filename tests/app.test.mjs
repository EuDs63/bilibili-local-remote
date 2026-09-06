import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function element() {
  const listeners = new Map();
  const node = {
    hidden: false, style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    value: "", textContent: "", disabled: false, title: "", max: 100, checked: false,
    addEventListener(type, fn) { listeners.set(type, fn); },
    dispatch(type, extra = {}) {
      return listeners.get(type)?.({ preventDefault() {}, currentTarget: this, ...extra });
    },
    focus() {}, select() {}, setAttribute() {}, setPointerCapture() {},
    children: [],
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    querySelector() { return element(); },
  };
  return node;
}

function loadApp(fetchImpl, { runDelays = false } = {}) {
  const elements = new Map();
  const get = (selector) => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  const commandButtons = [];
  const document = {
    hidden: false,
    documentElement: { dataset: {}, style: {} },
    body: element(),
    createElement() { return element(); },
    querySelector: get,
    querySelectorAll(selector) {
      if (selector === "[data-command]") return commandButtons;
      if (selector === "[data-hold-seek]") return [get("#seek-back"), get("#seek-forward")];
      return [];
    },
    addEventListener() {},
  };
  let nextTimerId = 1;
  const timers = new Map();
  const context = {
    document,
    navigator: {},
    RemoteFeatures: {
      extractUrls() { return []; },
      bookmarkFromPlayer() { return null; },
      buildTabTree(tabs) {
        return [{ windowId: 1, entries: [{ key: "ungrouped", group: null, tabs }] }];
      },
      createThemeController({ root }) {
        root.dataset.theme = "light";
        return { theme: "light", toggle() { this.theme = "dark"; return this.theme; } };
      },
    },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: fetchImpl,
    AbortController,
    URL,
    encodeURIComponent,
    console,
    Date,
    setTimeout(fn, ms) {
      if (runDelays && ms === 300) {
        queueMicrotask(fn);
        return nextTimerId++;
      }
      const id = nextTimerId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  context.globalThis = context;
  const testSource = `${source}\nglobalThis.__remoteTest = {
    awaitCommandResult,
    renderState,
    refresh,
    loadInfo,
    scheduleRefresh,
    renderTabs,
    setDraggingProgress(value) { draggingProgress = value; },
    setDraggingVolume(value) { draggingVolume = value; },
    setPendingVolume(value) { pendingVolume = value; },
    getPendingVolume() { return pendingVolume; },
    getDraggingProgress() { return draggingProgress; },
    getDraggingVolume() { return draggingVolume; },
  };`;
  vm.runInNewContext(testSource, context, { filename: "public/app.js" });
  return {
    api: context.__remoteTest,
    context,
    get,
    runNextTimer(ms) {
      const entry = [...timers].find(([, timer]) => ms === undefined || timer.ms === ms);
      assert.ok(entry, "expected a pending timer");
      timers.delete(entry[0]);
      return entry[1].fn();
    },
    hasTimer(ms) {
      return [...timers.values()].some((timer) => timer.ms === ms);
    },
  };
}

async function flushMicrotasks(count = 20) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function player(volumeValue, title = "video") {
  return {
    extensionConnected: true, playerActive: true,
    player: {
      title, siteName: "site", currentTime: 5, duration: 100, volume: volumeValue,
      muted: false, paused: true, playbackRate: 1, capabilities: {},
    },
  };
}

test("an older overlapping state response cannot overwrite the newer state", async () => {
  let resolveOld;
  let stateCalls = 0;
  const old = new Promise((resolve) => { resolveOld = resolve; });
  const { api, get } = loadApp(async (path) => {
    if (path === "/api/info") return response({ pairingRequired: false });
    if (path === "/api/state") {
      stateCalls += 1;
      return stateCalls === 1 ? old : response(player(0.8, "new"));
    }
    throw new Error("unexpected request");
  });
  await Promise.resolve();
  const first = api.refresh();
  const second = api.refresh();
  await second;
  resolveOld(response(player(0.2, "old")));
  await first;
  assert.equal(get("#video-title").textContent, "new");
  assert.equal(Number(get("#volume").value), 0.8);
});

test("state refresh preserves a dragged or pending local volume", async () => {
  const { api, get } = loadApp(async (path) => {
    if (path === "/api/info") return response({ pairingRequired: false });
    return response(player(0.2));
  });
  await Promise.resolve();
  get("#volume").value = 0.9;
  api.setDraggingVolume(true);
  api.renderState(player(0.2));
  assert.equal(Number(get("#volume").value), 0.9);
  api.setDraggingVolume(false);
  api.setPendingVolume(0.9);
  api.renderState(player(0.2));
  assert.equal(Number(get("#volume").value), 0.9);
  api.renderState(player(0.9));
  assert.equal(api.getPendingVolume(), null);
  get("#current-time").textContent = "0:42";
  api.setDraggingProgress(true);
  api.renderState(player(0.9));
  assert.equal(get("#current-time").textContent, "0:42");
});

test("command result polling reports extension failure detail", async () => {
  let polls = 0;
  const { api } = loadApp(async (path) => {
    if (path === "/api/info") return response({ pairingRequired: false });
    if (path.startsWith("/api/command-result")) {
      polls += 1;
      return response(polls === 1
        ? { status: "pending" }
        : { seq: 7, bootId: "boot", status: "failed", detail: "页面拒绝全屏" });
    }
    return response(player(0.5));
  }, { runDelays: true });
  await Promise.resolve();
  const result = await api.awaitCommandResult(7, "boot");
  assert.equal(result.status, "failed", `polls=${polls}, result=${JSON.stringify(result)}`);
  assert.equal(result.detail, "页面拒绝全屏");
});

test("bounded command polling returns uncertainty rather than success", async () => {
  const { api } = loadApp(async (path) => {
    if (path === "/api/info") return response({ pairingRequired: false });
    if (path.startsWith("/api/command-result")) return response({ status: "pending" });
    return response(player(0.5));
  }, { runDelays: true });
  await Promise.resolve();
  const result = await api.awaitCommandResult(8, "boot");
  assert.equal(result.status, "timeout");
  assert.match(result.detail, /暂未确认/);
});

test("scheduler keeps at most one state request in flight", async () => {
  let stateCalls = 0;
  let resolveState;
  const pendingState = new Promise((resolve) => { resolveState = resolve; });
  const app = loadApp(async (path) => {
    if (path === "/api/info") return response({ pairingRequired: false });
    if (path === "/api/state") {
      stateCalls += 1;
      return pendingState;
    }
    throw new Error("unexpected request");
  });
  await flushMicrotasks();
  app.runNextTimer(0);
  await flushMicrotasks();
  assert.equal(stateCalls, 1);
  app.api.scheduleRefresh(0);
  app.runNextTimer(0);
  await flushMicrotasks();
  assert.equal(stateCalls, 1);
  resolveState(response(player(0.5)));
  await flushMicrotasks();
});

test("scheduler retries initial info failure and recovers no-pairing mode", async () => {
  let infoCalls = 0;
  let stateCalls = 0;
  const app = loadApp(async (path) => {
    if (path === "/api/info") {
      infoCalls += 1;
      if (infoCalls === 1) throw new Error("offline");
      return response({ pairingRequired: false });
    }
    if (path === "/api/state") {
      stateCalls += 1;
      return response(player(0.5));
    }
    throw new Error("unexpected request");
  });
  await flushMicrotasks();
  app.runNextTimer(0);
  await flushMicrotasks();
  assert.equal(infoCalls, 2);
  assert.equal(stateCalls, 1);
  assert.equal(app.get("#remote-view").hidden, false);
});

test("pointerup without change releases progress and volume drag guards", async () => {
  const app = loadApp(async (path) => {
    if (path === "/api/info") return response({ pairingRequired: false });
    return response(player(0.2));
  });
  await flushMicrotasks();
  app.get("#progress").dispatch("pointerdown", { pointerId: 1 });
  app.get("#volume").dispatch("pointerdown", { pointerId: 2 });
  app.get("#progress").dispatch("pointerup");
  app.get("#volume").dispatch("pointerup");
  assert.equal(app.api.getDraggingProgress(), true);
  assert.equal(app.api.getDraggingVolume(), true);
  app.runNextTimer(250);
  app.runNextTimer(250);
  assert.equal(app.api.getDraggingProgress(), false);
  assert.equal(app.api.getDraggingVolume(), false);
});

test("an older volume failure cannot clear a newer pending value", async () => {
  let sequence = 0;
  const app = loadApp(async (path) => {
    if (path === "/api/info") return response({ pairingRequired: false });
    if (path === "/api/command") {
      sequence += 1;
      return response({ ok: true, seq: sequence, bootId: "boot" });
    }
    if (path.includes("seq=1")) {
      return response({ seq: 1, bootId: "boot", status: "failed", detail: "old failure" });
    }
    if (path.includes("seq=2")) {
      return response({ seq: 2, bootId: "boot", status: "succeeded", detail: "ok" });
    }
    if (path === "/api/state") return response(player(0.2));
    throw new Error("unexpected request: " + path);
  });
  await flushMicrotasks();
  app.get("#volume").value = 0.4;
  const first = app.get("#volume").dispatch("change");
  await flushMicrotasks();
  app.get("#volume").value = 0.8;
  const second = app.get("#volume").dispatch("change");
  await flushMicrotasks();
  app.runNextTimer(300);
  app.runNextTimer(300);
  await Promise.all([first, second]);
  assert.equal(app.api.getPendingVolume(), 0.8);
});

test("hold seek serializes repeats and cancellation prevents another command", async () => {
  let commandCalls = 0;
  const app = loadApp(async (path) => {
    if (path === "/api/info") return response({ pairingRequired: false });
    if (path === "/api/command") {
      commandCalls += 1;
      return response({ ok: true, seq: commandCalls, bootId: "boot" });
    }
    if (path.startsWith("/api/command-result")) {
      return response({ status: "succeeded", detail: "ok" });
    }
    if (path === "/api/state") return response(player(0.2));
    throw new Error("unexpected request: " + path);
  });
  await flushMicrotasks();
  const button = app.get("#seek-forward");
  button.dataset.holdSeek = "1";
  button.dispatch("pointerdown");
  app.runNextTimer(450);
  await flushMicrotasks();
  assert.equal(commandCalls, 1);
  app.runNextTimer(300);
  await flushMicrotasks();
  assert.equal(app.hasTimer(180), true);
  button.dispatch("pointercancel");
  assert.equal(app.hasTimer(180), false);
  assert.equal(commandCalls, 1);
});

test("tab lock button sends the selected tab id", async () => {
  let commandBody;
  const app = loadApp(async (path, options) => {
    if (path === "/api/info") return response({ pairingRequired: false });
    if (path === "/api/command") {
      commandBody = JSON.parse(options.body);
      return response({ ok: true, seq: 1, bootId: "boot" });
    }
    if (path.startsWith("/api/command-result")) {
      return response({ status: "succeeded" });
    }
    if (path === "/api/state") return response(player(0.2));
    throw new Error("unexpected request: " + path);
  });
  await flushMicrotasks();
  app.api.renderTabs([{ id: 9, title: "Tab", siteName: "Site", paused: true, hasVideo: true }], 8, null);
  const section = app.get("#tabs-list").children[0];
  const row = section.children[1].children[1];
  const lockButton = row.children[1].children[1];
  const pending = lockButton.dispatch("click");
  await flushMicrotasks();
  app.runNextTimer(300);
  await pending;
  assert.deepEqual(commandBody, { type: "lockTab", value: 9 });
});

test("ordinary tab exposes only switch and preserves the phone group expansion", async () => {
  let commandBody;
  const app = loadApp(async (path, options) => {
    if (path === "/api/info") return response({ pairingRequired: false });
    if (path === "/api/command") {
      commandBody = JSON.parse(options.body);
      return response({ ok: true, seq: 1, bootId: "boot" });
    }
    if (path.startsWith("/api/command-result")) return response({ status: "succeeded" });
    return response(player(0.2));
  });
  await flushMicrotasks();
  app.context.RemoteFeatures.buildTabTree = (tabs) => [{
    windowId: 3,
    entries: [{ key: "group:0", group: { id: 0, title: "Group", collapsed: false }, tabs }],
  }];
  const tabs = [{ id: 12, windowId: 3, index: 0, title: "Settings", hasVideo: false }];
  app.api.renderTabs(tabs, 9, null);
  let section = app.get("#tabs-list").children[0];
  let group = section.children[1];
  const row = group.children[1];
  assert.equal(row.children[1].children.length, 2);
  assert.equal(row.children[1].children[1].disabled, true);
  const pending = row.children[1].children[0].dispatch("click");
  await flushMicrotasks();
  app.runNextTimer(300);
  await pending;
  assert.deepEqual(commandBody, { type: "selectTab", value: 12 });
  group.open = false;
  group.dispatch("toggle");
  app.api.renderTabs([{ ...tabs[0], title: "Settings updated" }], 9, null);
  section = app.get("#tabs-list").children[0];
  group = section.children[1];
  assert.equal(group.open, false);
});

test("tab close always sends an id and stays deduplicated across rerenders", async () => {
  let commandCalls = 0;
  let commandBody;
  let resolveResult;
  const pendingResult = new Promise((resolve) => { resolveResult = resolve; });
  const app = loadApp(async (path, options) => {
    if (path === "/api/info") return response({ pairingRequired: false });
    if (path === "/api/command") {
      commandCalls += 1;
      commandBody = JSON.parse(options.body);
      return response({ ok: true, seq: 4, bootId: "boot" });
    }
    if (path.startsWith("/api/command-result")) return pendingResult;
    return response(player(0.2));
  });
  await flushMicrotasks();
  const tabs = [{ id: 21, title: "Closable", hasVideo: true }];
  app.api.renderTabs(tabs, 21, null, true, 1, false, { status: "ready" }, true);
  let section = app.get("#tabs-list").children[0];
  let close = section.children[1].children[1].children[1].children[2];
  const first = close.dispatch("click");
  await flushMicrotasks();
  app.runNextTimer(300);
  await flushMicrotasks();
  app.api.renderTabs([{ ...tabs[0], title: "Updated" }], 21, null, true, 1, false, { status: "ready" }, true);
  section = app.get("#tabs-list").children[0];
  close = section.children[1].children[1].children[1].children[2];
  close.dispatch("click");
  assert.equal(commandCalls, 1);
  assert.deepEqual(commandBody, { type: "closeTab", value: 21 });
  resolveResult(response({ status: "succeeded" }));
  await first;
});

test("missing close-by-id capability keeps row close disabled", async () => {
  const app = loadApp(async (path) => {
    if (path === "/api/info") return response({ pairingRequired: false });
    return response(player(0.2));
  });
  await flushMicrotasks();
  app.api.renderTabs([{ id: 5, title: "Old extension", hasVideo: false }], null, null, true, 1, false, { status: "ready" }, false);
  const section = app.get("#tabs-list").children[0];
  const close = section.children[1].children[1].children[1].children[1];
  assert.equal(close.disabled, true);
  assert.match(close.title, /重启本地服务/);
});

test("no-player state clears stale media while leaving the tab catalog rendered", async () => {
  const app = loadApp(async (path) => {
    if (path === "/api/info") return response({ pairingRequired: false });
    return response(player(0.2));
  });
  await flushMicrotasks();
  app.api.renderState(player(0.5, "Old video"));
  app.api.renderState({
    extensionConnected: true,
    playerActive: false,
    player: null,
    tabs: [{ id: 7, title: "Normal page", hasVideo: false }],
    catalogStatus: { status: "ready" },
    totalTabCount: 1,
  });
  assert.equal(app.get("#video-title").textContent, "当前没有可控制的视频");
  assert.equal(app.get("#progress").disabled, true);
  assert.equal(app.get("#progress").value, 0);
  assert.equal(app.get("#play-icon").textContent, "▶");
  assert.equal(app.get("#speed-value").textContent, "1×");
  assert.equal(app.get("#volume-value").textContent, "0%");
  assert.equal(app.get("#tabs-list").children.length, 1);
  app.api.renderState(player(0.5, "Restored video"));
  assert.equal(app.get("#progress").disabled, false);
});
