const SERVER = "http://127.0.0.1:17331";
const VIDEO_TAB_PATTERNS = ["http://*/*", "https://*/*"];
const JOURNAL_KEY = "remoteCommandJournalV1";
const CONTROL_KEY = "remoteControlTargetV1";
const JOURNAL_LIMIT = 64;
const TARGET_FRESH_MS = 8000;
let controlledTabId = null;
let controlledPaused = true;
let currentBootId = null;
let loopPromise = null;
let lockedTabId = null;
let catalogTimer = null;
let catalogPublishing = false;
let catalogDirty = false;
const players = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now();
const commandKey = (bootId, seq) => `${bootId}:${seq}`;
const isFullscreenCommand = (command) => command.type === "fullscreen" || command.type === "webFullscreen";
const playerFullscreenSelectors = [
  ".bpx-player-ctrl-full",
  ".bpx-player-ctrl-fullscreen",
  ".bilibili-player-video-btn-fullscreen",
  ".squirtle-video-fullscreen",
  ".ytp-fullscreen-button",
  ".plyr__controls__item.plyr__control[data-plyr='fullscreen']",
  ".plyr__control[data-plyr='fullscreen']",
  ".plyr [data-plyr='fullscreen']",
  "[data-fullscreen-button]",
  "[data-testid='fullscreen-button']",
  "button[aria-label*='full screen' i]",
  "button[title*='full screen' i]",
  "[role='button'][aria-label*='full screen' i]",
  "[aria-label='进入全屏']",
  "[aria-label='全屏']",
  "button[aria-label*='全屏']",
  "[data-title='进入全屏']",
  "[data-title='全屏']",
  "button[title*='全屏']",
];

async function focusTab(tab) {
  try {
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    // Focusing can be denied when the browser window is minimized or controlled by the OS.
  }
  await chrome.tabs.update(tab.id ?? tab.tabId, { active: true });
  await sleep(80);
}

async function trustedPlayerFullscreen(tabId) {
  const debuggee = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(debuggee, "1.3");
    attached = true;
    const playerPoint = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression: `(() => {
        const videos = [...document.querySelectorAll("video")];
        const video = videos.sort((left, right) => {
          const leftRect = left.getBoundingClientRect();
          const rightRect = right.getBoundingClientRect();
          return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
        })[0];
        const element = video?.closest(".bpx-player-video-wrap, .bpx-player-container, .html5-video-player, .plyr, [class*='player']") || video;
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`,
      returnByValue: true,
    });
    const hoverPoint = playerPoint?.result?.value;
    if (hoverPoint) {
      await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: hoverPoint.x,
        y: hoverPoint.y,
      });
      await sleep(120);
    }
    const buttonPoint = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression: `(() => {
        const selectors = ${JSON.stringify(playerFullscreenSelectors)};
        for (const selector of selectors) {
          for (const element of document.querySelectorAll(selector)) {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            if (rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden") {
              return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            }
          }
        }
        return null;
      })()`,
      returnByValue: true,
    });
    const point = buttonPoint?.result?.value;
    if (point) {
      await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
        type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1,
      });
      await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1,
      });
      return true;
    }
    const requested = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression: `(async () => {
        const videos = [...document.querySelectorAll("video")];
        const video = videos.find((item) => !item.paused) || videos[0];
        if (!video) return false;
        const target = video.closest(".html5-video-player, .plyr, [class*='player']") || video;
        try {
          await target.requestFullscreen();
          return true;
        } catch {
          return false;
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    return Boolean(requested?.result?.value);
  } catch {
    return false;
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(debuggee);
      } catch {
        // The tab may have closed or detached itself after entering fullscreen.
      }
    }
  }
}

async function serverFetch(path, options = {}) {
  const response = await fetch(`${SERVER}${path}`, { ...options, cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `本地服务返回 ${response.status}`);
    error.status = response.status;
    error.serverMessage = body.error || "";
    throw error;
  }
  return body;
}

function rememberPlayer(tab, state) {
  if (!tab?.id || !state) return;
  players.set(tab.id, {
    tabId: tab.id,
    windowId: tab.windowId,
    active: Boolean(tab.active),
    audible: Boolean(tab.audible),
    incognito: Boolean(tab.incognito),
    state,
    seenAt: now(),
  });
  scheduleCatalog();
}

function targetIsFresh(tabId) {
  const item = players.get(tabId);
  return Boolean(item && now() - item.seenAt <= TARGET_FRESH_MS);
}

function considerTarget(tab, state) {
  rememberPlayer(tab, state);
  if (lockedTabId !== null && tab.id !== lockedTabId) return false;
  const current = players.get(controlledTabId);
  const use = controlledTabId === null || tab.id === controlledTabId || !targetIsFresh(controlledTabId)
    || (!state.paused && tab.active && (controlledPaused || !current?.active));
  if (!use) return false;
  controlledTabId = tab.id;
  controlledPaused = Boolean(state.paused);
  return true;
}
async function discoverPlayers() {
  const tabs = await chrome.tabs.query({ url: VIDEO_TAB_PATTERNS });
  await Promise.allSettled(tabs.filter(({ id }) => id).map(async (tab) => {
    const response = await chrome.tabs.sendMessage(tab.id, { kind: "player-probe" });
    if (response?.state) rememberPlayer(tab, response.state);
  }));
}
async function selectTarget() {
  if (lockedTabId !== null) {
    if (targetIsFresh(lockedTabId)) return players.get(lockedTabId);
    await discoverPlayers();
    if (targetIsFresh(lockedTabId)) return players.get(lockedTabId);
    lockedTabId = null;
    controlledTabId = null;
    controlledPaused = true;
    await saveControlTarget();
    scheduleCatalog(0);
    return null;
  }
  if (targetIsFresh(controlledTabId)) return players.get(controlledTabId);
  await discoverPlayers();
  const target = [...players.values()].filter((item) => now() - item.seenAt <= TARGET_FRESH_MS).sort((a, b) => {
    const score = (x) => (x.tabId === controlledTabId ? 16 : 0) + (!x.state.paused ? 8 : 0) + (x.active ? 4 : 0) + (x.audible ? 2 : 0);
    return score(b) - score(a) || b.seenAt - a.seenAt;
  })[0] || null;
  if (target) {
    controlledTabId = target.tabId;
    controlledPaused = Boolean(target.state.paused);
  }
  return target;
}
async function openVideoUrl(url, startTime) {
  const target = await selectTarget();
  if (target) {
    const sameUrl = target.state.url === url;
    if (!sameUrl) await chrome.tabs.update(target.tabId, { active: true, url });
    await focusTab(target);
    if (!sameUrl) players.delete(target.tabId);
    controlledTabId = target.tabId;
    if (Number.isFinite(startTime)) await seekOpenedVideo(target.tabId, url, startTime);
    return target.tabId;
  }
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true, url: VIDEO_TAB_PATTERNS });
  if (activeTabs[0]?.id) {
    await chrome.tabs.update(activeTabs[0].id, { active: true, url });
    await focusTab(activeTabs[0]);
    controlledTabId = activeTabs[0].id;
    controlledPaused = true;
    if (Number.isFinite(startTime)) await seekOpenedVideo(activeTabs[0].id, url, startTime);
    return activeTabs[0].id;
  }
  const created = await chrome.tabs.create({ url, active: true });
  controlledTabId = created.id;
  controlledPaused = true;
  if (Number.isFinite(startTime)) await seekOpenedVideo(created.id, url, startTime);
  return created.id;
}

async function seekOpenedVideo(tabId, url, startTime) {
  const deadline = now() + 15000;
  let lastError = "视频页面尚未准备好";
  while (now() < deadline) {
    try {
      const tab = chrome.tabs.get ? await chrome.tabs.get(tabId) : null;
      if (tab) {
        const expected = new URL(url);
        const actual = new URL(tab.url || "about:blank");
        expected.hash = "";
        actual.hash = "";
        if (tab.pendingUrl || tab.status === "loading" || actual.href !== expected.href) {
          await sleep(300);
          continue;
        }
      }
      const result = await chrome.tabs.sendMessage(tabId, {
        kind: "remote-command",
        command: { type: "resumeAt", value: { url, time: startTime } },
      });
      if (result?.handled) return;
      lastError = result?.detail || lastError;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await sleep(300);
  }
  throw new Error(`已打开视频，但恢复时间点失败：${lastError}`);
}

async function saveControlTarget() {
  await chrome.storage.local.set({ [CONTROL_KEY]: { lockedTabId } });
}

async function loadControlTarget() {
  const stored = await chrome.storage.local.get(CONTROL_KEY);
  const value = stored?.[CONTROL_KEY]?.lockedTabId;
  lockedTabId = Number.isInteger(value) && value > 0 ? value : null;
}

function displaySiteName(tab, player) {
  if (player?.state.siteName) return String(player.state.siteName).slice(0, 200);
  try {
    const url = new URL(tab.url || "");
    return url.hostname || url.protocol.replace(":", "") || "浏览器页面";
  } catch {
    return "浏览器页面";
  }
}

async function buildCatalog() {
  const cutoff = now() - TARGET_FRESH_MS;
  for (const [tabId, item] of players) {
    if (item.seenAt < cutoff) players.delete(tabId);
  }
  const tabs = await chrome.tabs.query({});
  let groups = [];
  try {
    groups = chrome.tabGroups ? await chrome.tabGroups.query({}) : [];
  } catch {
    groups = [];
  }
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const selectedTabId = targetIsFresh(controlledTabId) ? controlledTabId : null;
  const currentLockedTabId = targetIsFresh(lockedTabId) ? lockedTabId : null;
  const catalogTabs = tabs.slice(0, 5000).map((tab) => {
    const player = players.get(tab.id);
    const hasVideo = Boolean(player && player.seenAt >= cutoff);
    const groupId = Number.isInteger(tab.groupId) && tab.groupId >= 0 ? tab.groupId : null;
    const group = groupId === null ? null : groupsById.get(groupId);
    return {
      id: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      title: String(tab.title || player?.state.title || "未命名标签页").slice(0, 200),
      url: String(tab.url || ""),
      siteName: displaySiteName(tab, player),
      active: Boolean(tab.active),
      pinned: Boolean(tab.pinned),
      discarded: Boolean(tab.discarded),
      hasVideo,
      paused: hasVideo ? Boolean(player.state.paused) : true,
      audible: Boolean(tab.audible),
      incognito: Boolean(tab.incognito),
      group: groupId === null ? null : {
        id: groupId,
        title: String(group?.title || "未命名分组").slice(0, 200),
        color: group?.color || "grey",
        collapsed: Boolean(group?.collapsed),
      },
    };
  });
  const byteLength = (value) => {
    const json = typeof value === "string" ? value : JSON.stringify(value);
    return typeof TextEncoder === "undefined" ? json.length * 3 : new TextEncoder().encode(json).length;
  };
  const maximumBytes = 3_900_000;
  const baseBytes = byteLength({
    tabs: [],
    totalTabCount: tabs.length,
    truncated: true,
    selectedTabId,
    lockedTabId: currentLockedTabId,
    supportsCloseTabById: true,
  });
  const tabSizes = catalogTabs.map((tab) => byteLength(tab) + 1);
  const specialIds = new Set([selectedTabId, currentLockedTabId].filter((id) => id !== null));
  let remainingSpecialBytes = catalogTabs.reduce(
    (total, tab, index) => total + (specialIds.has(tab.id) ? tabSizes[index] : 0),
    0,
  );
  let usedBytes = baseBytes;
  const includedTabs = [];
  for (let index = 0; index < catalogTabs.length; index += 1) {
    const tab = catalogTabs[index];
    const size = tabSizes[index];
    if (specialIds.has(tab.id)) {
      remainingSpecialBytes -= size;
      if (usedBytes + size <= maximumBytes) {
        includedTabs.push(tab);
        usedBytes += size;
      }
      continue;
    }
    if (usedBytes + size + remainingSpecialBytes <= maximumBytes) {
      includedTabs.push(tab);
      usedBytes += size;
    }
  }
  const includedVideoIds = new Set(
    includedTabs.filter((tab) => tab.hasVideo).map((tab) => tab.id),
  );
  return {
    tabs: includedTabs,
    totalTabCount: tabs.length,
    truncated: tabs.length > includedTabs.length,
    selectedTabId: includedVideoIds.has(selectedTabId) ? selectedTabId : null,
    lockedTabId: includedVideoIds.has(currentLockedTabId) ? currentLockedTabId : null,
    supportsCloseTabById: true,
  };
}

function scheduleCatalog(delay = 1000, force = false) {
  catalogDirty = true;
  if (force && catalogTimer !== null) {
    clearTimeout(catalogTimer);
    catalogTimer = null;
  }
  if (catalogTimer !== null || catalogPublishing) return;
  catalogTimer = setTimeout(() => {
    catalogTimer = null;
    publishCatalog().catch(() => {});
  }, delay);
}

async function publishCatalog() {
  if (catalogPublishing) {
    catalogDirty = true;
    return;
  }
  catalogPublishing = true;
  catalogDirty = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const body = await buildCatalog();
    await serverFetch("/api/extension/catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    catalogDirty = true;
    console.error("[网页视频遥控器] 标签页目录发布失败，将自动重试", error);
  } finally {
    clearTimeout(timeout);
    catalogPublishing = false;
    if (catalogDirty) scheduleCatalog(1000);
  }
}

async function reportSelectedState(target) {
  if (!target) return;
  await serverFetch("/api/extension/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...target.state,
      tabId: target.tabId,
      incognito: target.incognito,
    }),
  });
}

async function closeKnownTab(tabId) {
  await chrome.tabs.get(tabId);
  await chrome.tabs.remove(tabId);
  players.delete(tabId);
  if (lockedTabId === tabId) {
    lockedTabId = null;
    await saveControlTarget();
  }
  if (controlledTabId === tabId) {
    controlledTabId = null;
    controlledPaused = true;
  }
  scheduleCatalog(0, true);
  return { handled: true, detail: `已关闭标签页 ${tabId}` };
}

async function dispatch(command) {
  if (command.type === "openUrl") {
    const url = typeof command.value === "string" ? command.value : command.value?.url;
    const startTime = Number(command.startTime ?? command.value?.startTime);
    const tabId = await openVideoUrl(url, Number.isFinite(startTime) ? startTime : undefined);
    return { handled: true, detail: `已在标签页 ${tabId} 打开链接` };
  }
  if (command.type === "selectTab") {
    const tabId = Number(command.value);
    const tab = await chrome.tabs.get(tabId);
    await focusTab(tab);
    if (!targetIsFresh(tabId) && /^https?:/i.test(tab.url || "")) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, { kind: "player-probe" });
        if (response?.state) rememberPlayer(tab, response.state);
      } catch {}
    }
    const target = targetIsFresh(tabId) ? players.get(tabId) : null;
    if (target) {
      controlledTabId = tabId;
      controlledPaused = Boolean(target.state.paused);
      if (lockedTabId !== null && lockedTabId !== tabId) {
        lockedTabId = tabId;
        await saveControlTarget();
      }
      await reportSelectedState(target);
    }
    scheduleCatalog(0, true);
    return {
      handled: true,
      detail: target
        ? `已切换视频遥控目标到标签页 ${tabId}`
        : `已聚焦标签页 ${tabId}；视频遥控目标保持不变`,
    };
  }
  if (command.type === "lockTab") {
    if (command.value === null) {
      lockedTabId = null;
      await saveControlTarget();
      scheduleCatalog(0, true);
      return { handled: true, detail: "已解除标签页锁定" };
    }
    const tabId = Number(command.value);
    await discoverPlayers();
    const target = players.get(tabId);
    if (!target || !targetIsFresh(tabId)) return { handled: false, detail: "要锁定的视频标签页已不可用" };
    lockedTabId = tabId;
    controlledTabId = tabId;
    controlledPaused = Boolean(target.state.paused);
    await saveControlTarget();
    await reportSelectedState(target);
    scheduleCatalog(0, true);
    return { handled: true, detail: `已锁定标签页 ${tabId}` };
  }
  if (command.type === "closeTab" && Object.hasOwn(command, "value")) {
    const tabId = command.value;
    if (!Number.isSafeInteger(tabId) || tabId <= 0) {
      return { handled: false, detail: "要关闭的标签页编号无效" };
    }
    return closeKnownTab(tabId);
  }
  const target = await selectTarget();
  if (!target) return { handled: false, detail: "没有找到可控制的视频标签页" };
  if (command.type === "closeTab") {
    return closeKnownTab(target.tabId);
  }
  try {
    if (isFullscreenCommand(command)) {
      await focusTab(target);
      if (await trustedPlayerFullscreen(target.tabId)) return { handled: true, detail: `标签页 ${target.tabId} 已执行全屏` };
    }
    const result = await chrome.tabs.sendMessage(target.tabId, { kind: "remote-command", command });
    if (result?.handled) {
      return { handled: true, detail: `标签页 ${target.tabId} 已处理 ${command.type}` };
    }
    return { handled: false, detail: result?.detail || `标签页 ${target.tabId} 不支持 ${command.type}` };
  } catch (error) {
    return { handled: false, detail: error?.message || String(error) };
  }
}

async function loadJournal() {
  const stored = await chrome.storage.local.get(JOURNAL_KEY);
  const value = stored?.[JOURNAL_KEY];
  return value && typeof value === "object" ? value : { cursorByBoot: {}, entries: {} };
}
function compactJournal(journal, bootId) {
  const entries = Object.entries(journal.entries || {}).filter(([key]) => key.startsWith(`${bootId}:`));
  if (entries.length > JOURNAL_LIMIT) throw new Error("本地命令日志已满，暂停执行以防止重复操作");
  journal.entries = Object.fromEntries(entries);
  journal.cursorByBoot = { [bootId]: Number(journal.cursorByBoot?.[bootId]) || 0 };
  return journal;
}

function reconcileJournal(journal, bootId, acknowledgedSeq) {
  compactJournal(journal, bootId);
  const cursor = Math.max(
    Number(journal.cursorByBoot[bootId]) || 0,
    Number(acknowledgedSeq) || 0,
  );
  journal.cursorByBoot[bootId] = cursor;
  for (const key of Object.keys(journal.entries)) {
    const seq = Number(key.slice(key.lastIndexOf(":") + 1));
    if (key.startsWith(`${bootId}:`) && seq <= cursor) delete journal.entries[key];
  }
  return cursor;
}
async function saveJournal(journal) {
  await chrome.storage.local.set({ [JOURNAL_KEY]: journal });
}
async function postOutcome(bootId, seq, outcome) {
  return serverFetch("/api/extension/result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seq, bootId, handled: outcome.handled, detail: outcome.detail }),
  });
}
async function processCommand(journal, bootId, command) {
  const key = commandKey(bootId, command.seq);
  let entry = journal.entries[key];
  if (entry?.status === "executing") {
    entry = { status: "done", outcome: { handled: false, detail: "浏览器后台在执行期间重启；为避免重复操作，未重新执行该命令" } };
    journal.entries[key] = entry;
    await saveJournal(journal);
  }
  if (!entry) {
    journal.entries[key] = { status: "executing" };
    compactJournal(journal, bootId);
    await saveJournal(journal);
    let outcome;
    try {
      outcome = await dispatch(command);
    } catch (error) {
      outcome = { handled: false, detail: error?.message || String(error) };
    }
    entry = { status: "done", outcome };
    journal.entries[key] = entry;
    await saveJournal(journal);
  }
  try {
    await postOutcome(bootId, command.seq, entry.outcome);
  } catch (error) {
    // A valid command can disappear from the server's bounded history after a long outage.
    // Advancing this already-finalized local entry avoids a permanent queue stall.
    const serverAlreadyFinal = error?.status === 409 && /已有不同的执行结果/.test(error.serverMessage);
    if (error?.status !== 400 && !serverAlreadyFinal) throw error;
  }
  journal.cursorByBoot[bootId] = Math.max(Number(journal.cursorByBoot[bootId]) || 0, command.seq);
  delete journal.entries[key];
  await saveJournal(journal);
  return journal.cursorByBoot[bootId];
}
async function commandLoop() {
  while (true) {
    try {
      await loadControlTarget();
      scheduleCatalog(0);
      const journal = await loadJournal();
      const hello = await serverFetch("/api/extension/hello");
      currentBootId = hello.bootId;
      let cursor = reconcileJournal(journal, currentBootId, hello.acknowledgedSeq);
      await saveJournal(journal);
      while (true) {
        const batch = await serverFetch(`/api/extension/commands?after=${cursor}`); if (batch.bootId !== currentBootId) break;
        for (const command of batch.commands || []) cursor = await processCommand(journal, currentBootId, command);
        if (!(batch.commands || []).length) await sleep(250);
      }
    } catch { await sleep(1500); }
  }
}
function ensureCommandLoop() {
  if (!loopPromise) {
    loopPromise = commandLoop().finally(() => { loopPromise = null; });
  }
  return loopPromise;
}

if (!globalThis.__EXTENSION_TEST__ && typeof chrome !== "undefined" && chrome.runtime) {
  chrome.runtime.onMessage.addListener((message, sender) => {
    ensureCommandLoop();
    if (message?.kind === "player-unavailable" && sender.tab?.id) {
      players.delete(sender.tab.id);
      if (sender.tab.id === controlledTabId && sender.tab.id !== lockedTabId) {
        controlledTabId = null;
        controlledPaused = true;
      }
      scheduleCatalog(0, true);
      return;
    }
    if (message?.kind !== "player-state" || !sender.tab?.id || !message.state || !considerTarget(sender.tab, message.state)) return;
    serverFetch("/api/extension/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...message.state,
        tabId: sender.tab.id,
        incognito: Boolean(sender.tab.incognito),
      }),
    }).catch(() => {});
  });
  chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.clear("bili-remote-wakeup");
    chrome.alarms.create("video-remote-wakeup", { periodInMinutes: 0.5 });
    ensureCommandLoop();
  });
  chrome.runtime.onStartup.addListener(ensureCommandLoop);
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "video-remote-wakeup") ensureCommandLoop(); });
  chrome.tabs.onRemoved.addListener((tabId) => {
    players.delete(tabId);
    if (tabId === lockedTabId) {
      lockedTabId = null;
      saveControlTarget().catch(() => {});
    }
    if (tabId === controlledTabId) {
      controlledTabId = null;
      controlledPaused = true;
    }
    scheduleCatalog(0, true);
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === "loading") {
      players.delete(tabId);
      if (tabId === controlledTabId && tabId !== lockedTabId) {
        controlledTabId = null;
        controlledPaused = true;
      }
    }
    scheduleCatalog();
  });
  chrome.tabs.onCreated.addListener(() => scheduleCatalog());
  chrome.tabs.onMoved.addListener(() => scheduleCatalog());
  chrome.tabs.onActivated.addListener(() => scheduleCatalog());
  chrome.tabs.onAttached.addListener(() => scheduleCatalog());
  chrome.tabs.onDetached.addListener(() => scheduleCatalog());
  if (chrome.tabGroups) {
    chrome.tabGroups.onCreated.addListener(() => scheduleCatalog());
    chrome.tabGroups.onUpdated.addListener(() => scheduleCatalog());
    chrome.tabGroups.onMoved.addListener(() => scheduleCatalog());
    chrome.tabGroups.onRemoved.addListener(() => scheduleCatalog());
  }
  chrome.alarms.create("video-remote-wakeup", { periodInMinutes: 0.5 });
  setInterval(() => scheduleCatalog(), 5000);
  scheduleCatalog(0, true);
  ensureCommandLoop();
}
if (globalThis.__EXTENSION_TEST__) {
  globalThis.__extensionTestHooks = { processCommand, loadJournal, reconcileJournal, buildCatalog };
}
