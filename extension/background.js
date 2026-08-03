const SERVER = "http://127.0.0.1:7331";
let controlledTabId = null;
let currentBootId = null;
let loopPromise = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isFullscreenCommand = (command) => command.type === "fullscreen" || command.type === "webFullscreen";
const playerFullscreenSelectors = [
  ".bpx-player-ctrl-full",
  ".bpx-player-ctrl-fullscreen",
  ".bilibili-player-video-btn-fullscreen",
  ".squirtle-video-fullscreen",
  "[aria-label='进入全屏']",
  "[aria-label='全屏']",
  "[data-title='进入全屏']",
  "[data-title='全屏']",
  "[title='全屏']",
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
        const element = document.querySelector(".bpx-player-video-wrap, .bpx-player-container, video");
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
    if (!point) return false;

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
  if (!response.ok) throw new Error(`Local server returned ${response.status}`);
  return response.json();
}

async function biliTabs() {
  const tabs = await chrome.tabs.query({ url: ["https://bilibili.com/*", "https://*.bilibili.com/*"] });
  return tabs.sort((left, right) => {
    const leftScore = (left.id === controlledTabId ? 8 : 0) + (left.audible ? 4 : 0) + (left.active ? 2 : 0);
    const rightScore = (right.id === controlledTabId ? 8 : 0) + (right.audible ? 4 : 0) + (right.active ? 2 : 0);
    return rightScore - leftScore || (right.lastAccessed || 0) - (left.lastAccessed || 0);
  });
}

async function openBilibiliUrl(url) {
  const tabs = await biliTabs();
  const target = tabs.find((tab) => tab.active) || tabs[0];
  if (target?.id) {
    controlledTabId = target.id;
    await chrome.tabs.update(target.id, { url });
  } else {
    const created = await chrome.tabs.create({ url, active: true });
    controlledTabId = created.id;
  }
}

async function dispatch(command) {
  if (command.type === "openUrl") {
    await openBilibiliUrl(command.value);
    return;
  }
  const tabs = await biliTabs();
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      if (isFullscreenCommand(command)) {
        await focusTab(tab);
        if (await trustedPlayerFullscreen(tab.id)) {
          controlledTabId = tab.id;
          return;
        }
      }
      const result = await chrome.tabs.sendMessage(tab.id, { kind: "remote-command", command });
      if (result?.handled) {
        controlledTabId = tab.id;
        return;
      }
    } catch {
      // Try another Bilibili tab when this one has no content script/player.
    }
  }
}

async function commandLoop() {
  let cursor = 0;
  while (true) {
    try {
      const hello = await serverFetch("/api/extension/hello");
      if (hello.bootId !== currentBootId) {
        currentBootId = hello.bootId;
        cursor = hello.latestSeq;
      }
      while (true) {
        const batch = await serverFetch(`/api/extension/commands?after=${cursor}`);
        if (batch.bootId !== currentBootId) break;
        for (const command of batch.commands) {
          await dispatch(command);
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
  const shouldUse = controlledTabId === null || sender.tab.id === controlledTabId || sender.tab.audible;
  if (!shouldUse) return;
  controlledTabId = sender.tab.id;
  serverFetch("/api/extension/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message.state),
  }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("bili-remote-wakeup", { periodInMinutes: 0.5 });
  ensureCommandLoop();
});
chrome.runtime.onStartup.addListener(ensureCommandLoop);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "bili-remote-wakeup") ensureCommandLoop();
});
chrome.alarms.create("bili-remote-wakeup", { periodInMinutes: 0.5 });
ensureCommandLoop();
