import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");

function video(name) {
  const listeners = new Map();
  return {
    name, isConnected: true, paused: true, ended: false, readyState: 4,
    duration: 100, currentTime: 5, volume: 1, muted: false, playbackRate: 1,
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
    closest: () => null, play: async () => {}, pause: () => {},
    listeners,
  };
}

function runContent({ episodeLabels = [] } = {}) {
  let videos = [video("first")];
  let episodeElements = episodeLabels.map((label) => ({
    isConnected: true,
    textContent: label,
    matches: () => false,
    querySelector: () => null,
    getAttribute: () => null,
    click() {},
  }));
  let videoQueries = 0;
  const sent = [], intervals = [], timers = [];
  let mutationCallback;
  let runtimeListener;
  const document = {
    title: "Example video",
    documentElement: {},
    pictureInPictureElement: null,
    querySelector(selector) { return selector === "video" ? videos[0] || null : null; },
    querySelectorAll(selector) {
      if (selector === "video") { videoQueries += 1; return videos; }
      if (selector === ".video-pod__item") return episodeElements;
      return [];
    },
  };
  class MutationObserver { constructor(callback) { mutationCallback = callback; } observe() {} }
  class HTMLElement {}
  const context = {
    document, MutationObserver, HTMLElement,
    location: { href: "https://example.test/watch", hostname: "example.test" },
    window: { focus() {}, addEventListener() {} },
    MouseEvent: class {},
    chrome: { runtime: { sendMessage: async (message) => { sent.push(message); }, onMessage: { addListener(listener) { runtimeListener = listener; } } } },
    setInterval: (callback, delay) => { intervals.push({ callback, delay }); },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {}, console, URL,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "content.js" });
  const flush = () => { while (timers.length) timers.shift().callback(); };
  return {
    sent,
    intervals,
    flush,
    mutate: () => mutationCallback([]),
    setVideos: (next) => { videos = next; },
    setEpisodes: (next) => { episodeElements = next; },
    getEpisodes: () => episodeElements,
    invoke: (command) => new Promise((resolve) => runtimeListener(
      { kind: "remote-command", command },
      {},
      resolve,
    )),
    videoQueries: () => videoQueries,
    first: videos[0],
  };
}

test("heartbeat reports cached state without repeating full DOM video discovery", () => {
  const page = runContent();
  page.flush();
  const initialQueries = page.videoQueries();
  const heartbeat = page.intervals.find(({ delay }) => delay === 1800);
  heartbeat.callback();
  heartbeat.callback();
  assert.equal(page.videoQueries(), initialQueries);
  assert.ok(page.sent.length >= 2);
});

test("media events schedule a throttled report and dynamic insertion is rediscovered", () => {
  const page = runContent();
  page.flush();
  const before = page.sent.length;
  page.first.listeners.get("play")({ type: "play" });
  page.flush();
  assert.ok(page.sent.length > before);
  const replacement = video("replacement");
  page.first.isConnected = false;
  page.setVideos([replacement]);
  const queries = page.videoQueries();
  page.mutate();
  page.flush();
  assert.ok(page.videoQueries() > queries);
  assert.ok(replacement.listeners.has("play"));
});

test("Bilibili episode fixtures are reported and a removed identity cannot click a replacement", async () => {
  const page = runContent({ episodeLabels: ["第一集", "第二集"] });
  page.flush();
  const state = page.sent.at(-1).state;
  assert.deepEqual(Array.from(state.episodes, (episode) => episode.title), ["第一集", "第二集"]);
  const staleId = state.episodes[0].id;
  page.setEpisodes([{
    isConnected: true,
    textContent: "插入的新分集",
    matches: () => false,
    querySelector: () => null,
    getAttribute: () => null,
    click: () => assert.fail("stale identity clicked a replacement"),
  }]);
  page.mutate();
  page.flush();
  const result = await page.invoke({
    type: "selectEpisode",
    value: { id: staleId, pageUrl: "https://example.test/watch" },
  });
  assert.equal(result.handled, false);
  assert.match(result.detail, /不存在/);
});

test("bookmark resume waits for metadata and then clamps the requested time", async () => {
  const page = runContent();
  page.first.readyState = 0;
  let result = await page.invoke({
    type: "resumeAt",
    value: { url: "https://example.test/watch", time: 150 },
  });
  assert.equal(result.handled, false);
  assert.match(result.detail, /元数据/);
  page.first.readyState = 1;
  result = await page.invoke({
    type: "resumeAt",
    value: { url: "https://example.test/watch", time: 150 },
  });
  assert.equal(result.handled, true);
  assert.equal(page.first.currentTime, 100);
});

test("an episode id becomes stale when a SPA reuses the same element for different content", async () => {
  const page = runContent({ episodeLabels: ["原分集"] });
  page.flush();
  const staleId = page.sent.at(-1).state.episodes[0].id;
  page.getEpisodes()[0].textContent = "替换后的分集";
  page.mutate();
  page.flush();
  const result = await page.invoke({
    type: "selectEpisode",
    value: { id: staleId, pageUrl: "https://example.test/watch" },
  });
  assert.equal(result.handled, false);
});
