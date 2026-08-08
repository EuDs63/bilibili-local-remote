import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractVideoUrl, startServer } from "../server.mjs";

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
  t.after(() => {
    running.server.close();
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

  const result = await fetch(`${origin}/api/extension/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seq: 1, handled: true, detail: "测试标签页已处理" }),
  });
  assert.equal(result.status, 200);
  const helloAfterResult = await fetch(`${origin}/api/extension/hello`).then((response) => response.json());
  assert.equal(helloAfterResult.acknowledgedSeq, 1);

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
});

test("no-pairing mode accepts phone commands without a token", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "bili-remote-open-test-"));
  const running = await startServer({ host: "127.0.0.1", port: 0, dataDir, noPairing: true, logger: null });
  t.after(() => {
    running.server.close();
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
});
