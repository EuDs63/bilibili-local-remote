import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractBilibiliUrl, startServer } from "../server.mjs";

test("extracts Bilibili links from complete share text", () => {
  assert.equal(
    extractBilibiliUrl("【四嬛魔性复合，皇后破大防-哔哩哔哩】 https://b23.tv/EEAsshD"),
    "https://b23.tv/EEAsshD",
  );
  assert.equal(
    extractBilibiliUrl("推荐：https://www.bilibili.com/video/BV1test?p=2。"),
    "https://www.bilibili.com/video/BV1test?p=2",
  );
  assert.equal(extractBilibiliUrl("这里没有视频链接"), null);
});

test("pair, authenticate, report state, and deliver a command", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "bili-remote-test-"));
  const running = await startServer({ host: "127.0.0.1", port: 0, dataDir });
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

  const playerState = {
    title: "测试视频",
    currentTime: 12,
    duration: 120,
    volume: 0.5,
    muted: false,
    paused: true,
    playbackRate: 1,
    url: "https://www.bilibili.com/video/BV1test",
  };
  const stateResult = await fetch(`${origin}/api/extension/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(playerState),
  });
  assert.equal(stateResult.status, 200);

  const commandResult = await fetch(`${origin}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bili-Remote-Token": running.token },
    body: JSON.stringify({ type: "seekBy", value: 10 }),
  });
  assert.equal(commandResult.status, 202);

  const commands = await fetch(`${origin}/api/extension/commands?after=0`).then((response) => response.json());
  assert.equal(commands.commands.length, 1);
  assert.equal(commands.commands[0].type, "seekBy");
  assert.equal(commands.commands[0].value, 10);

  const state = await fetch(`${origin}/api/state`, {
    headers: { "X-Bili-Remote-Token": running.token },
  }).then((response) => response.json());
  assert.equal(state.player.title, "测试视频");
  assert.equal(state.extensionConnected, true);
});

test("no-pairing mode accepts phone commands without a token", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "bili-remote-open-test-"));
  const running = await startServer({ host: "127.0.0.1", port: 0, dataDir, noPairing: true });
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

  const command = await fetch(`${origin}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "openUrl",
      value: "【分享视频】 https://b23.tv/EEAsshD",
    }),
  });
  assert.equal(command.status, 202);

  const commands = await fetch(`${origin}/api/extension/commands?after=0`).then((response) => response.json());
  assert.equal(commands.commands[0].value, "https://b23.tv/EEAsshD");
});
