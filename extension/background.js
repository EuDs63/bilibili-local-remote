const SERVER = "http://127.0.0.1:17331";
const VIDEO_TAB_PATTERNS = ["http://*/*", "https://*/*"];
let controlledTabId = null;
let controlledPaused = true;
let currentBootId = null;
let loopPromise = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  await chrome.tabs.update(tab.id, { active: true });
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
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
      await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
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
  if (!response.ok) throw new Error(body.error || `本地服务返回 ${response.status}`);
  return body;
}

async function videoTabs() {
  const tabs = await chrome.tabs.query({ url: VIDEO_TAB_PATTERNS });
  return tabs.sort((left, right) => {
    const leftScore = (left.id === controlledTabId ? 8 : 0) + (left.audible ? 4 : 0) + (left.active ? 2 : 0);
    const rightScore = (right.id === controlledTabId ? 8 : 0) + (right.audible ? 4 : 0) + (right.active ? 2 : 0);
    return rightScore - leftScore || (right.lastAccessed || 0) - (left.lastAccessed || 0);
  });
}

async function openVideoUrl(url) {
  const tabs = await videoTabs();
  const target = tabs.find((tab) => tab.id === controlledTabId)
    || tabs.find((tab) => tab.active)
    || tabs[0];
  if (target?.id) {
    controlledTabId = target.id;
    await chrome.tabs.update(target.id, { active: true, url });
    await focusTab(target);
    return target.id;
  } else {
    const created = await chrome.tabs.create({ url, active: true });
    controlledTabId = created.id;
    await focusTab(created);
    return created.id;
  }
}

async function dispatch(command) {
  if (command.type === "openUrl") {
    const tabId = await openVideoUrl(command.value);
    return { handled: true, detail: `已在标签页 ${tabId} 打开链接` };
  }
  if (command.type === "closeTab") {
    if (controlledTabId === null) {
      return { handled: false, detail: "当前没有受控的视频标签页" };
    }
    const tabId = controlledTabId;
    await chrome.tabs.remove(tabId);
    controlledTabId = null;
    controlledPaused = true;
    return { handled: true, detail: `已关闭标签页 ${tabId}` };
  }
  const tabs = await videoTabs();
  let lastError = "";
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      if (isFullscreenCommand(command)) {
        await focusTab(tab);
        if (await trustedPlayerFullscreen(tab.id)) {
          controlledTabId = tab.id;
          return { handled: true, detail: `标签页 ${tab.id} 已执行全屏` };
        }
      }
      const result = await chrome.tabs.sendMessage(tab.id, { kind: "remote-command", command });
      if (result?.handled) {
        controlledTabId = tab.id;
        return { handled: true, detail: `标签页 ${tab.id} 已处理 ${command.type}` };
      }
    } catch (error) {
      lastError = error?.message || String(error);
      // Try another web tab when this one has no content script or video player.
    }
  }
  return {
    handled: false,
    detail: lastError || "没有找到能处理该命令的视频标签页",
  };
}

async function commandLoop() {
  let cursor = 0;
  while (true) {
    try {
      const hello = await serverFetch("/api/extension/hello");
      if (hello.bootId !== currentBootId) {
        currentBootId = hello.bootId;
        cursor = Math.max(0, Number(hello.acknowledgedSeq) || 0);
      }
      while (true) {
        const batch = await serverFetch(`/api/extension/commands?after=${cursor}`);
        if (batch.bootId !== currentBootId) break;
        for (const command of batch.commands) {
          let outcome;
          try {
            outcome = await dispatch(command);
          } catch (error) {
            outcome = { handled: false, detail: error?.message || String(error) };
          }
          await serverFetch("/api/extension/result", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              seq: command.seq,
              handled: outcome.handled,
              detail: outcome.detail,
            }),
          });
          cursor = Math.max(cursor, command.seq);
        }
        cursor = Math.max(cursor, batch.latestSeq || 0);
      }
    } catch {
      await sleep(1500);
    }
  }
}

function ensureCommandLoop() {
  if (!loopPromise) {
    loopPromise = commandLoop().finally(() => { loopPromise = null; });
  }
  return loopPromise;
}

chrome.runtime.onMessage.addListener((message, sender) => {
  ensureCommandLoop();
  if (message?.kind !== "player-state" || !sender.tab?.id) return;
  const sameTab = sender.tab.id === controlledTabId;
  const shouldUse = controlledTabId === null
    || sameTab
    || sender.tab.audible
    || (sender.tab.active && !message.state?.paused && controlledPaused);
  if (!shouldUse) return;
  controlledTabId = sender.tab.id;
  controlledPaused = Boolean(message.state?.paused);
  serverFetch("/api/extension/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message.state),
  }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.clear("bili-remote-wakeup");
  chrome.alarms.create("video-remote-wakeup", { periodInMinutes: 0.5 });
  ensureCommandLoop();
});
chrome.runtime.onStartup.addListener(ensureCommandLoop);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "video-remote-wakeup") ensureCommandLoop();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === controlledTabId) {
    controlledTabId = null;
    controlledPaused = true;
  }
});
chrome.alarms.create("video-remote-wakeup", { periodInMinutes: 0.5 });
ensureCommandLoop();
