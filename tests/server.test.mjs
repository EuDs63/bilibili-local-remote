import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import test from "node:test";
import { extractVideoUrl, startServer } from "../server.mjs";

function rawRequest(port, request) {
  return new Promise((resolve, reject) => {
    let response = "";
    const socket = connect(port, "127.0.0.1", () => socket.end(request));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

test("extracts safe HTTP video links from share text", () => {
  assert.equal(
    extractVideoUrl("【四嬛魔性复合，皇后破大防-哔哩哔哩】 https://b23.tv/EEAsshD"),
    "https://b23.tv/EEAsshD",
  );
  assert.equal(
    extractVideoUrl("推荐：https://www.bilibili.com/video/BV1test?p=2。"),
    "https://www.bilibili.com/video/BV1test?p=2",
  );
  assert.equal(
    extractVideoUrl("Watch this: https://www.youtube.com/watch?v=dQw4w9WgXcQ)."),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
  assert.equal(extractVideoUrl("https://user:secret@example.com/video"), null);
  assert.equal(extractVideoUrl("http://[::1]"), "http://[::1]/");
  assert.equal(extractVideoUrl("javascript:alert(1)"), null);
  assert.equal(extractVideoUrl("这里没有视频链接"), null);
});

test("pair, authenticate, report state, and deliver a command", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "bili-remote-test-"));
  const logs = [];
  const logger = {
    error: (message) => logs.push(message),
    log: (message) => logs.push(message),
    warn: (message) => logs.push(message),
  };
  const running = await startServer({ host: "127.0.0.1", port: 0, dataDir, logger });
  t.after(async () => {
    await new Promise((resolve) => running.server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${running.port}`;
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /床上遥控器/);

  const info = await fetch(`${origin}/api/info`).then((response) => response.json());
  assert.equal(info.pairingRequired, true);
  assert.equal(info.version, "0.3.6");

  const badPair = await fetch(`${origin}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "9999999" }),
  });
  assert.equal(badPair.status, 401);

  const pair = await fetch(`${origin}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: running.pairingCode }),
  });
  assert.equal(pair.status, 200);
  assert.equal((await pair.json()).token, running.token);

  const unauthorized = await fetch(`${origin}/api/state`);
  assert.equal(unauthorized.status, 401);

  const hello = await fetch(`${origin}/api/extension/hello`).then((response) => response.json());
  assert.equal(hello.latestSeq, 0);
  assert.equal(hello.acknowledgedSeq, 0);

  const playerState = {
    title: "测试视频",
    currentTime: 12,
    duration: 120,
    volume: 0.5,
    muted: false,
    paused: true,
    playbackRate: 1,
    url: "https://www.youtube.com/watch?v=test",
    siteName: "YouTube",
    capabilities: { fullscreen: true, next: true, previous: false, danmaku: false },
  };
  const stateResult = await fetch(`${origin}/api/extension/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(playerState),
  });
  assert.equal(stateResult.status, 200);

  const commandController = new AbortController();
  const pendingCommands = fetch(`${origin}/api/extension/commands?after=0`, {
    signal: commandController.signal,
  }).then((response) => response.json());
  await new Promise((resolve) => setTimeout(resolve, 25));

  const commandResult = await fetch(`${origin}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Video-Remote-Token": running.token },
    body: JSON.stringify({ type: "seekBy", value: 10 }),
  });
  assert.equal(commandResult.status, 202);
  const accepted = await commandResult.json();
  assert.equal(accepted.seq, 1);
  assert.equal(accepted.bootId, running.bootId);

  let commandTimeout;
  const commands = await Promise.race([
    pendingCommands,
    new Promise((_, reject) => {
      commandTimeout = setTimeout(() => reject(new Error("long poll did not flush")), 1000);
    }),
  ]).finally(() => {
    clearTimeout(commandTimeout);
    commandController.abort();
  });
  assert.equal(commands.commands.length, 1);
  assert.equal(commands.commands[0].type, "seekBy");
  assert.equal(commands.commands[0].value, 10);

  const unauthorizedResult = await fetch(
    `${origin}/api/command-result?seq=1&bootId=${running.bootId}`,
  );
  assert.equal(unauthorizedResult.status, 401);

  const pendingResult = await fetch(
    `${origin}/api/command-result?seq=1&bootId=${running.bootId}`,
    { headers: { "X-Video-Remote-Token": running.token } },
  );
  assert.equal(pendingResult.status, 200);
  assert.deepEqual(await pendingResult.json(), {
    seq: 1,
    bootId: running.bootId,
    status: "pending",
    detail: "",
  });

  const staleResult = await fetch(`${origin}/api/command-result?seq=1&bootId=old`, {
    headers: { "X-Video-Remote-Token": running.token },
  });
  assert.equal(staleResult.status, 409);

  const unknownResult = await fetch(
    `${origin}/api/command-result?seq=999&bootId=${running.bootId}`,
    { headers: { "X-Video-Remote-Token": running.token } },
  );
  assert.equal(unknownResult.status, 404);

  const staleExtensionResult = await fetch(`${origin}/api/extension/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seq: 1, bootId: "old", handled: false, detail: "不应写入" }),
  });
  assert.equal(staleExtensionResult.status, 409);

  const stillPending = await fetch(
    `${origin}/api/command-result?seq=1&bootId=${running.bootId}`,
    { headers: { "X-Video-Remote-Token": running.token } },
  ).then((response) => response.json());
  assert.equal(stillPending.status, "pending");

  const result = await fetch(`${origin}/api/extension/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seq: 1, bootId: running.bootId, handled: true, detail: "测试标签页已处理" }),
  });
  assert.equal(result.status, 200);
  const duplicateResult = await fetch(`${origin}/api/extension/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seq: 1, bootId: running.bootId, handled: true, detail: "测试标签页已处理" }),
  });
  assert.equal(duplicateResult.status, 200);
  assert.equal((await duplicateResult.json()).duplicate, true);

  const conflictingResult = await fetch(`${origin}/api/extension/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seq: 1, bootId: running.bootId, handled: false, detail: "晚到的冲突结果" }),
  });
  assert.equal(conflictingResult.status, 409);

  const finalResult = await fetch(
    `${origin}/api/command-result?seq=1&bootId=${running.bootId}`,
    { headers: { "X-Video-Remote-Token": running.token } },
  ).then((response) => response.json());
  assert.equal(finalResult.status, "succeeded");
  assert.equal(finalResult.detail, "测试标签页已处理");

  const secondCommand = await fetch(`${origin}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Video-Remote-Token": running.token },
    body: JSON.stringify({ type: "pause" }),
  });
  assert.equal(secondCommand.status, 202);
  const failedReport = await fetch(`${origin}/api/extension/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seq: 2, handled: false, detail: "目标标签页已关闭" }),
  });
  assert.equal(failedReport.status, 200);
  const failedResult = await fetch(
    `${origin}/api/command-result?seq=2&bootId=${running.bootId}`,
    { headers: { "X-Video-Remote-Token": running.token } },
  ).then((response) => response.json());
  assert.equal(failedResult.status, "failed");
  assert.equal(failedResult.detail, "目标标签页已关闭");
  const helloAfterResult = await fetch(`${origin}/api/extension/hello`).then((response) => response.json());
  assert.equal(helloAfterResult.acknowledgedSeq, 2);

  const state = await fetch(`${origin}/api/state`, {
    headers: { "X-Video-Remote-Token": running.token },
  }).then((response) => response.json());
  assert.equal(state.player.title, "测试视频");
  assert.equal(state.player.siteName, "YouTube");
  assert.equal(state.player.capabilities.next, true);
  assert.equal(state.player.capabilities.danmaku, false);
  assert.equal(state.extensionConnected, true);

  const legacyHeader = await fetch(`${origin}/api/state`, {
    headers: { "X-Bili-Remote-Token": running.token },
  });
  assert.equal(legacyHeader.status, 200);
  assert.ok(logs.some((message) => message.includes("[扩展] 已连接")));
  assert.ok(logs.some((message) => message.includes("[播放器] YouTube · 测试视频")));
  assert.ok(logs.some((message) => message.includes("#1 已入队")));
  assert.ok(logs.some((message) => message.includes("#1 执行成功")));
  assert.equal(logs.filter((message) => message.includes("#1 执行成功")).length, 1);
});

test("malformed Host returns 400 and the server remains available", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "bili-remote-host-test-"));
  const running = await startServer({ host: "127.0.0.1", port: 0, dataDir, noPairing: true, logger: null });
  t.after(async () => {
    await new Promise((resolve) => running.server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });

  const response = await rawRequest(
    running.port,
    "GET /api/info HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n",
  );
  assert.match(response, /^HTTP\/1\.1 400 /);

  const healthy = await fetch(`http://127.0.0.1:${running.port}/api/info`);
  assert.equal(healthy.status, 200);

  const malformedPath = await fetch(`http://127.0.0.1:${running.port}/%ZZ`);
  assert.equal(malformedPath.status, 400);
});

test("no-pairing mode accepts phone commands without a token", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "bili-remote-open-test-"));
  const running = await startServer({ host: "127.0.0.1", port: 0, dataDir, noPairing: true, logger: null });
  t.after(async () => {
    await new Promise((resolve) => running.server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${running.port}`;
  const info = await fetch(`${origin}/api/info`).then((response) => response.json());
  assert.equal(info.pairingRequired, false);

  const state = await fetch(`${origin}/api/state`);
  assert.equal(state.status, 200);
  assert.equal((await state.json()).pairingRequired, false);

  const disconnectedCommand = await fetch(`${origin}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "openUrl",
      value: "【分享视频】 https://www.youtube.com/watch?v=test",
    }),
  });
  assert.equal(disconnectedCommand.status, 409);
  assert.match((await disconnectedCommand.json()).error, /扩展未连接/);

  const hello = await fetch(`${origin}/api/extension/hello`).then((response) => response.json());
  assert.equal(hello.latestSeq, 0);

  const command = await fetch(`${origin}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "openUrl",
      value: "【分享视频】 https://www.youtube.com/watch?v=test",
    }),
  });
  assert.equal(command.status, 202);

  const commands = await fetch(`${origin}/api/extension/commands?after=0`).then((response) => response.json());
  assert.equal(commands.commands[0].value, "https://www.youtube.com/watch?v=test");

  const closeCommand = await fetch(`${origin}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "closeTab" }),
  });
  assert.equal(closeCommand.status, 202);
  const closeCommands = await fetch(`${origin}/api/extension/commands?after=1`).then((response) => response.json());
  assert.equal(closeCommands.commands[0].type, "closeTab");
  assert.equal(Object.hasOwn(closeCommands.commands[0], "value"), false);

  for (const invalidValue of [null, 0, -1, "17"]) {
    const invalidClose = await fetch(`${origin}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "closeTab", value: invalidValue }),
    });
    assert.equal(invalidClose.status, 400);
  }
  await fetch(`${origin}/api/extension/catalog`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tabs: [], selectedTabId: null, lockedTabId: null }),
  });
  assert.equal((await fetch(`${origin}/api/state`).then((response) => response.json())).supportsCloseTabById, false);
  const unsupportedExplicitClose = await fetch(`${origin}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "closeTab", value: 17 }),
  });
  assert.equal(unsupportedExplicitClose.status, 409);
  assert.match((await unsupportedExplicitClose.json()).error, /重新加载浏览器扩展/);
  await fetch(`${origin}/api/extension/catalog`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tabs: [], selectedTabId: null, lockedTabId: null, supportsCloseTabById: true }),
  });
  assert.equal((await fetch(`${origin}/api/state`).then((response) => response.json())).supportsCloseTabById, true);
  const explicitClose = await fetch(`${origin}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "closeTab", value: 17 }),
  });
  assert.equal(explicitClose.status, 202);
  const explicitCloseCommands = await fetch(`${origin}/api/extension/commands?after=2`).then((response) => response.json());
  assert.equal(explicitCloseCommands.commands[0].value, 17);

  for (let index = 0; index < 99; index += 1) {
    const extra = await fetch(`${origin}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "pause" }),
    });
    assert.equal(extra.status, 202);
  }
  const evicted = await fetch(`${origin}/api/command-result?seq=1&bootId=${running.bootId}`);
  assert.equal(evicted.status, 404);
});

test("catalog and persistent library validate data and preserve queue items until playback succeeds", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "bili-remote-library-test-"));
  let running = await startServer({ host: "127.0.0.1", port: 0, dataDir, catalogTimeoutMs: 20, logger: null });
  t.after(async () => {
    await new Promise((resolve) => running.server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });
  let origin = `http://127.0.0.1:${running.port}`;

  assert.equal((await fetch(`${origin}/api/library`)).status, 401);
  await fetch(`${origin}/api/extension/hello`);
  const headers = { "Content-Type": "application/json", "X-Video-Remote-Token": running.token };

  const invalidCatalog = await fetch(`${origin}/api/extension/catalog`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tabs: [{ id: -1, url: "bad" }], selectedTabId: null, lockedTabId: null }),
  });
  assert.equal(invalidCatalog.status, 400);
  let diagnosticState = await fetch(`${origin}/api/state`, { headers }).then((response) => response.json());
  assert.equal(diagnosticState.catalogStatus.status, "error");
  assert.match(diagnosticState.catalogStatus.lastError, /无效项目/);
  assert.equal(typeof diagnosticState.catalogStatus.lastFailureAt, "number");

  const mixedTabs = Array.from({ length: 101 }, (_, index) => ({
    id: index + 1,
    windowId: index < 50 ? 1 : 2,
    index: index < 50 ? index : index - 50,
    title: index === 0 ? "扩展设置" : `普通标签 ${index}`,
    siteName: "浏览器",
    url: index === 0 ? "chrome://extensions/" : index === 1 ? "" : index === 2 ? "尚未加载\u0000的地址" : `about:blank#${index}`,
    active: index === 0,
    pinned: index === 1,
    discarded: false,
    hasVideo: index === 100,
    paused: true,
    audible: false,
    incognito: false,
    group: index < 2 ? { id: 0, title: "同名组", color: "blue", collapsed: false } : null,
  }));
  const mixedCatalog = await fetch(`${origin}/api/extension/catalog`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tabs: mixedTabs, totalTabCount: 150, truncated: true, selectedTabId: 101, lockedTabId: null }),
  });
  assert.equal(mixedCatalog.status, 200);
  let mixedState = await fetch(`${origin}/api/state`, { headers }).then((response) => response.json());
  assert.equal(mixedState.tabs.length, 101);
  assert.equal(mixedState.tabs[0].url, "chrome://extensions/");
  assert.equal(mixedState.tabs[1].url, "");
  assert.equal(mixedState.tabs[2].url, "尚未加载的地址");
  assert.equal(mixedState.tabs[0].group.id, 0);
  assert.equal(mixedState.tabs[1].group.title, "同名组");
  assert.equal(mixedState.totalTabCount, 150);
  assert.equal(mixedState.truncated, true);
  assert.deepEqual(mixedState.catalogStatus.lastError, "");
  assert.equal(mixedState.catalogStatus.status, "ready");

  const ordinarySelected = await fetch(`${origin}/api/extension/catalog`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tabs: mixedTabs, totalTabCount: 101, truncated: false, selectedTabId: 1, lockedTabId: null }),
  });
  assert.equal(ordinarySelected.status, 400);

  const invalidGroup = structuredClone(mixedTabs.slice(0, 1));
  invalidGroup[0].group.color = "ultraviolet";
  const invalidGroupResponse = await fetch(`${origin}/api/extension/catalog`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tabs: invalidGroup, totalTabCount: 1, truncated: false, selectedTabId: null, lockedTabId: null }),
  });
  assert.equal(invalidGroupResponse.status, 400);

  const tooManyTabs = await fetch(`${origin}/api/extension/catalog`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tabs: Array.from({ length: 5001 }, (_, index) => ({ id: index + 1, title: "", url: "" })),
      totalTabCount: 5001, truncated: false, selectedTabId: null, lockedTabId: null,
    }),
  });
  assert.equal(tooManyTabs.status, 400);

  const oversizedCatalog = await fetch(`${origin}/api/extension/catalog`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tabs: [], totalTabCount: 0, truncated: false, selectedTabId: null, lockedTabId: null, padding: "x".repeat(4 * 1024 * 1024) }),
  });
  assert.equal(oversizedCatalog.status, 413);

  const catalogBody = {
    tabs: [
      { id: 11, title: "甲", siteName: "站点", url: "https://example.com/a", paused: false, audible: true, incognito: false },
      { id: 12, title: "乙", siteName: "站点", url: "https://example.com/b", paused: true, audible: false, incognito: false },
    ],
    selectedTabId: 11, lockedTabId: 11,
  };
  assert.equal((await fetch(`${origin}/api/extension/catalog`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(catalogBody),
  })).status, 200);
  await fetch(`${origin}/api/extension/state`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tabId: 11, title: "第 1 集", url: "https://example.com/a", currentTime: 42, duration: 100, episodes: [{ id: "ep1", title: "第 1 集", current: true }] }),
  });
  let state = await fetch(`${origin}/api/state`, { headers }).then((response) => response.json());
  assert.equal(state.tabs.length, 2);
  assert.equal(state.episodes[0].id, "ep1");
  await fetch(`${origin}/api/extension/state`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tabId: 99, incognito: true, title: "隐私视频", url: "https://example.com/private", currentTime: 9 }),
  });

  catalogBody.selectedTabId = 12;
  assert.equal((await fetch(`${origin}/api/extension/catalog`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(catalogBody),
  })).status, 200);
  state = await fetch(`${origin}/api/state`, { headers }).then((response) => response.json());
  assert.equal(state.player, null);
  assert.deepEqual(state.episodes, []);
  await new Promise((resolve) => setTimeout(resolve, 25));
  state = await fetch(`${origin}/api/state`, { headers }).then((response) => response.json());
  assert.deepEqual(state.tabs, []);
  assert.deepEqual(state.episodes, []);
  assert.equal(state.catalogStatus.status, "stale");

  let library = await fetch(`${origin}/api/library`, {
    method: "POST", headers, body: JSON.stringify({ action: "queue:add", items: [{ url: "https://example.com/q", title: "稍后播放" }] }),
  }).then((response) => response.json());
  const queueId = library.queue[0].id;
  const firstPlay = await fetch(`${origin}/api/library`, {
    method: "POST", headers, body: JSON.stringify({ action: "queue:play", id: queueId }),
  });
  assert.equal(firstPlay.status, 202);
  const firstAccepted = await firstPlay.json();
  assert.equal((await fetch(`${origin}/api/library`, {
    method: "POST", headers, body: JSON.stringify({ action: "queue:play", id: queueId }),
  })).status, 409);
  await fetch(`${origin}/api/extension/result`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seq: firstAccepted.seq, bootId: firstAccepted.bootId, handled: false, detail: "页面拒绝" }),
  });
  library = await fetch(`${origin}/api/library`, { headers }).then((response) => response.json());
  assert.equal(library.queue.length, 1);

  const retry = await fetch(`${origin}/api/library`, {
    method: "POST", headers, body: JSON.stringify({ action: "queue:play", id: queueId }),
  }).then((response) => response.json());
  await fetch(`${origin}/api/extension/result`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seq: retry.seq, bootId: retry.bootId, handled: true }),
  });
  library = await fetch(`${origin}/api/library`, { headers }).then((response) => response.json());
  assert.equal(library.queue.length, 0);

  library = await fetch(`${origin}/api/library`, {
    method: "POST", headers,
    body: JSON.stringify({ action: "bookmarks:add", url: "https://example.com/a", title: "精彩处", time: 42.5, note: "记住这里" }),
  }).then((response) => response.json());
  const bookmarkId = library.bookmarks[0].id;
  const bookmarkPlay = await fetch(`${origin}/api/library`, {
    method: "POST", headers, body: JSON.stringify({ action: "bookmarks:play", id: bookmarkId }),
  }).then((response) => response.json());
  const bookmarkCommands = await fetch(`${origin}/api/extension/commands?after=${bookmarkPlay.seq - 1}`).then((response) => response.json());
  assert.equal(bookmarkCommands.commands[0].startTime, 42.5);

  await new Promise((resolve) => running.server.close(resolve));
  running = await startServer({ host: "127.0.0.1", port: 0, dataDir, logger: null });
  origin = `http://127.0.0.1:${running.port}`;
  const persisted = await fetch(`${origin}/api/library`, {
    headers: { "X-Video-Remote-Token": running.token },
  }).then((response) => response.json());
  assert.equal(persisted.bookmarks[0].time, 42.5);
  assert.equal(persisted.history[0].time, 42);
  assert.equal(persisted.history.some((item) => item.url.includes("private")), false);
});
