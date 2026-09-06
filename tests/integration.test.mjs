import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { startServer } from "../server.mjs";

const backgroundSource = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

function loadBackground({ origin, storageData, counters, loseFirstResultResponse }) {
  const chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: storageData[key] }; },
        async set(values) { Object.assign(storageData, structuredClone(values)); },
      },
    },
    tabs: {
      async query() { return [{ id: 7, windowId: 1, active: true, audible: true }]; },
      async sendMessage(_tabId, message) {
        if (message.kind === "player-probe") {
          return { state: { paused: false } };
        }
        counters.dispatches += 1;
        return { handled: true };
      },
      async update() {},
      async create() { return { id: 8 }; },
      async remove() {},
    },
    windows: { async update() {} },
    debugger: { async attach() {}, async detach() {}, async sendCommand() {} },
  };
  let shouldLose = loseFirstResultResponse;
  const mappedFetch = async (url, options) => {
    const parsed = new URL(url);
    const response = await fetch(`${origin}${parsed.pathname}${parsed.search}`, options);
    if (parsed.pathname === "/api/extension/result" && shouldLose) {
      shouldLose = false;
      throw new Error("simulated lost acknowledgement response");
    }
    return response;
  };
  const context = vm.createContext({
    __EXTENSION_TEST__: true,
    chrome,
    console,
    fetch: mappedFetch,
    setTimeout,
    clearTimeout,
    structuredClone,
    URL,
  });
  new vm.Script(backgroundSource, { filename: "extension/background.js" }).runInContext(context);
  return context.__extensionTestHooks;
}

test("server and extension journal preserve an outcome across a lost acknowledgement and worker reload", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "bili-remote-integration-"));
  const running = await startServer({ host: "127.0.0.1", port: 0, dataDir, noPairing: true, logger: null });
  t.after(async () => {
    await new Promise((resolve) => running.server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${running.port}`;

  await fetch(`${origin}/api/extension/hello`);
  const accepted = await fetch(`${origin}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "toggle" }),
  }).then((response) => response.json());
  const batch = await fetch(`${origin}/api/extension/commands?after=0`).then((response) => response.json());
  assert.equal(batch.commands.length, 1);

  const storageData = {};
  const counters = { dispatches: 0 };
  const firstWorker = loadBackground({ origin, storageData, counters, loseFirstResultResponse: true });
  const firstJournal = { cursorByBoot: { [accepted.bootId]: 0 }, entries: {} };
  await assert.rejects(
    firstWorker.processCommand(firstJournal, accepted.bootId, batch.commands[0]),
    /lost acknowledgement/,
  );
  assert.equal(counters.dispatches, 1);

  const storedOutcome = await fetch(
    `${origin}/api/command-result?seq=${accepted.seq}&bootId=${accepted.bootId}`,
  ).then((response) => response.json());
  assert.equal(storedOutcome.status, "succeeded");

  const reloadedWorker = loadBackground({ origin, storageData, counters, loseFirstResultResponse: false });
  const reloadedJournal = await (async () => {
    const stored = storageData.remoteCommandJournalV1;
    return structuredClone(stored);
  })();
  const cursor = await reloadedWorker.processCommand(
    reloadedJournal,
    accepted.bootId,
    batch.commands[0],
  );
  assert.equal(cursor, accepted.seq);
  assert.equal(counters.dispatches, 1);
  assert.deepEqual(storageData.remoteCommandJournalV1.entries, {});
});
