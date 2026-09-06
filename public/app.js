const $ = (selector) => document.querySelector(selector);
const pairView = $("#pair-view");
const remoteView = $("#remote-view");
const pairForm = $("#pair-form");
const pairCode = $("#pair-code");
const pairSubmit = $("#pair-submit");
const pairError = $("#pair-error");
const connection = $("#connection");
const connectionText = $("#connection-text");
const progress = $("#progress");
const volume = $("#volume");
const toast = $("#toast");
const themeToggle = $("#theme-toggle");
const themeController = RemoteFeatures.createThemeController({
  storage: localStorage,
  root: document.documentElement,
  meta: document.querySelector('meta[name="theme-color"]'),
});
const LEGACY_TOKEN_KEY = "biliRemoteToken";
const TOKEN_KEY = "videoRemoteToken";
const REQUEST_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 9000;
let token = localStorage.getItem(TOKEN_KEY) || localStorage.getItem(LEGACY_TOKEN_KEY) || "";
let pairingRequired = null;
let latestPlayer = null;
let draggingProgress = false;
let draggingVolume = false;
let pendingVolume = null;
let toastTimer = null;
let stateRequestId = 0;
let schedulerTimer = null;
let refreshRunning = false;
let refreshFailures = 0;
let openUrlPending = false;
let volumeGeneration = 0;
let pendingVolumeRemainingStates = 0;
let progressReleaseTimer = null;
let volumeReleaseTimer = null;
let tabsSignature = "";
let episodesSignature = "";
const tabGroupExpanded = new Map();
const pendingCloseTabIds = new Set();

function renderThemeToggle() {
  const dark = themeController.theme === "dark";
  themeToggle.setAttribute("aria-pressed", String(dark));
  themeToggle.setAttribute("aria-label", dark ? "切换到日间模式" : "切换到夜间模式");
  themeToggle.querySelector("span").textContent = dark ? "日间" : "夜间";
}
themeToggle.addEventListener("click", () => {
  themeController.toggle();
  renderThemeToggle();
});
renderThemeToggle();

function setView(view) {
  const remote = view === "remote";
  pairView.hidden = remote;
  pairView.style.display = remote ? "none" : "";
  remoteView.hidden = !remote;
  remoteView.style.display = remote ? "" : "none";
}
function showRemote() {
  setView("remote");
}
function showPair() {
  setView("pair");
  pairCode.focus();
}
function notify(message, duration = 1800) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), duration);
}
function vibrate() {
  if (navigator.vibrate) navigator.vibrate(12);
}
function handleUnauthorized() {
  token = "";
  pairingRequired = true;
  stateRequestId += 1;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  showPair();
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers["X-Video-Remote-Token"] = token;
  if (options.body) headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, { ...options, headers, cache: "no-store", signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || (response.status === 401 ? "配对已失效" : "连接失败"));
      error.status = response.status;
      throw error;
    }
    return body;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("请求超时");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePairCode(value) {
  return String(value)
    .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10))
    .replace(/\D/g, "")
    .slice(0, 6);
}
function extractVideoUrl(value) {
  const match = String(value || "").match(/https?:\/\/[^\s<>"'，。！？；：、）】》]+/i);
  if (!match) return "";
  const candidate = match[0].replace(/[),.!?;:，。！？；：、）】》]+$/u, "");
  try {
    const url = new URL(candidate);
    const valid = ["http:", "https:"].includes(url.protocol)
      && url.hostname
      && !url.username
      && !url.password;
    return valid ? url.href : "";
  } catch {
    return "";
  }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function awaitCommandResult(seq, bootId, timeoutMs = COMMAND_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const maxAttempts = Math.ceil(timeoutMs / 300);
  for (let attempt = 0; attempt < maxAttempts && Date.now() < deadline; attempt += 1) {
    await delay(300);
    try {
      const result = await api(`/api/command-result?seq=${encodeURIComponent(seq)}&bootId=${encodeURIComponent(bootId)}`);
      if (result.status !== "pending") {
        return result;
      }
    } catch (error) {
      if (error.status === 401) {
        handleUnauthorized();
        return { status: "failed", detail: error.message };
      }
      if (error.status === 404 || error.status === 409) {
        return { status: "failed", detail: error.status === 409 ? "服务已重启，无法确认命令结果" : "命令结果已不可用" };
      }
    }
  }
  return { status: "timeout", detail: "命令已发送，但暂未确认执行结果" };
}

async function sendCommand(type, value, options = {}) {
  vibrate();
  try {
    const queued = await api("/api/command", {
      method: "POST",
      body: JSON.stringify(value === undefined ? { type } : { type, value }),
    });
    const result = await awaitCommandResult(queued.seq, queued.bootId);
    if (result.status === "succeeded") {
      // A state request started before execution must not restore pre-command UI.
      stateRequestId += 1;
      if (!options.quietSuccess) notify(result.detail || "操作成功");
    } else {
      notify(result.detail || "操作失败", 4200);
    }
    return result;
  } catch (error) {
    notify(error.message, 3600);
    return { status: "failed", detail: error.message };
  }
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}
function configureEpisodeAction(button, supported, direction) {
  const next = direction > 0;
  button.dataset.command = supported ? (next ? "next" : "previous") : "seekBy";
  if (supported) {
    delete button.dataset.value;
  } else {
    button.dataset.value = String(direction * 60);
  }
  button.querySelector("span").textContent = supported ? (next ? "下一集" : "上一集") : (next ? "+1 min" : "−1 min");
  button.setAttribute("aria-label", supported ? (next ? "下一集" : "上一集") : (next ? "快进一分钟" : "快退一分钟"));
}

function renderState(state) {
  const online = state.extensionConnected && state.playerActive;
  connection.dataset.state = online ? "online" : state.extensionConnected ? "waiting" : "offline";
  connectionText.textContent = online ? "已连接" : state.extensionConnected ? "等待视频" : "扩展未连接";
  $("#hint").textContent = online ? "手机和电脑正在通过家中网络连接" : state.extensionConnected ? "扩展已连接，请在 Edge 中打开一个网页视频" : "请确认 Edge 扩展已加载，并保持本地服务开启";
  renderTabs(
    state.tabs || [],
    state.selectedTabId,
    state.lockedTabId,
    state.extensionConnected,
    state.totalTabCount,
    state.truncated,
    state.catalogStatus,
    state.supportsCloseTabById === true,
  );
  if (!state.player) {
    latestPlayer = null;
    renderEpisodes([], "");
    $("#bookmark-form").querySelector("button[type=submit]").disabled = true;
    $("#site-name").textContent = "等待视频";
    $("#video-title").textContent = "当前没有可控制的视频";
    $("#current-time").textContent = "0:00";
    $("#duration").textContent = "0:00";
    progress.value = 0;
    volume.value = 0;
    $("#volume-value").textContent = "0%";
    $("#play-icon").textContent = "▶";
    $("#play-toggle").setAttribute("aria-label", "播放");
    $("#speed-value").textContent = "1×";
    setMediaControlsDisabled(true);
    return;
  }
  latestPlayer = state.player;
  setMediaControlsDisabled(false);
  const currentClose = $("#current-tab-close");
  if (state.supportsCloseTabById === true && Number.isInteger(state.player.tabId) && state.player.tabId > 0) {
    currentClose.dataset.value = String(state.player.tabId);
  } else {
    delete currentClose.dataset.value;
    currentClose.disabled = true;
  }
  $("#bookmark-form").querySelector("button[type=submit]").disabled = false;
  $("#site-name").textContent = state.player.siteName || "网页视频";
  $("#video-title").textContent = state.player.title || "网页视频";
  $("#duration").textContent = formatTime(state.player.duration);
  if (!draggingProgress) {
    $("#current-time").textContent = formatTime(state.player.currentTime);
    progress.max = Math.max(1, state.player.duration || 1);
    progress.value = Math.min(state.player.currentTime || 0, Number(progress.max));
  }
  const remoteVolume = state.player.muted ? 0 : state.player.volume;
  if (pendingVolume !== null && Math.abs(remoteVolume - pendingVolume) <= 0.011) {
    pendingVolume = null;
  } else if (pendingVolume !== null && pendingVolumeRemainingStates > 0) {
    pendingVolumeRemainingStates -= 1;
    if (pendingVolumeRemainingStates === 0) {
      pendingVolume = null;
    }
  }
  if (!draggingVolume && pendingVolume === null) {
    volume.value = remoteVolume;
    $("#volume-value").textContent = `${Math.round(remoteVolume * 100)}%`;
  }
  $("#play-icon").textContent = state.player.paused ? "▶" : "❚❚";
  $("#play-toggle").setAttribute("aria-label", state.player.paused ? "播放" : "暂停");
  $("#speed-value").textContent = `${state.player.playbackRate}×`;
  document.querySelectorAll(".speed-grid button").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.value) === state.player.playbackRate);
  });
  const capabilities = state.player.capabilities || {};
  configureEpisodeAction($("#previous-action"), Boolean(capabilities.previous), -1);
  configureEpisodeAction($("#next-action"), Boolean(capabilities.next), 1);
  document.querySelectorAll("[data-capability]").forEach((b) => {
    const supported = capabilities[b.dataset.capability] !== false && (b.dataset.capability === "fullscreen" || Boolean(capabilities[b.dataset.capability]));
    b.disabled = !supported;
    b.title = supported ? "" : "当前网站未提供此功能";
  });
  renderEpisodes(state.player.episodes || [], state.player.url);
}

function setMediaControlsDisabled(disabled) {
  progress.disabled = disabled;
  document.querySelectorAll(".transport button, .volume-panel button, .volume-panel input, .speed-grid button, .utility-grid button").forEach((control) => {
    control.disabled = disabled;
  });
}

async function refresh() {
  if (pairingRequired === true && !token) return false;
  const requestId = ++stateRequestId;
  try {
    const state = await api("/api/state");
    if (requestId !== stateRequestId) return true;
    renderState(state);
    refreshFailures = 0;
    return true;
  } catch (error) {
    if (requestId !== stateRequestId) return false;
    connection.dataset.state = "offline";
    connectionText.textContent = "服务未连接";
    refreshFailures += 1;
    if (error.status === 401) {
      handleUnauthorized();
    }
    return false;
  }
}
function nextRefreshDelay() {
  return document.hidden ? 5000 : Math.min(1000 * (2 ** Math.min(refreshFailures, 4)), 15000);
}
function scheduleRefresh(delayMs = nextRefreshDelay()) {
  clearTimeout(schedulerTimer);
  schedulerTimer = setTimeout(async () => {
    if (refreshRunning) return scheduleRefresh();
    refreshRunning = true;
    try {
      if (pairingRequired === null) await loadInfo();
      await refresh();
    } finally {
      refreshRunning = false;
      scheduleRefresh();
    }
  }, delayMs);
}

pairForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = normalizePairCode(pairCode.value);
  pairCode.value = code;
  if (code.length !== 6) {
    pairError.textContent = "请输入完整的六位配对码";
    pairCode.focus();
    return;
  }
  pairSubmit.disabled = true;
  pairSubmit.textContent = "正在连接…";
  pairError.textContent = "正在联系电脑…";
  try {
    const result = await api("/api/pair", { method: "POST", body: JSON.stringify({ code }) });
    token = result.token || "";
    pairingRequired = result.pairingRequired !== false;
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    }
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    showRemote();
    scheduleRefresh(0);
  } catch (error) {
    pairError.textContent = error.message;
    pairCode.select();
  } finally {
    pairSubmit.disabled = false;
    pairSubmit.textContent = "连接遥控器";
  }
});
pairCode.addEventListener("input", () => {
  const value = normalizePairCode(pairCode.value);
  if (value !== pairCode.value) {
    pairCode.value = value;
  }
  pairError.textContent = "";
});
document.querySelectorAll("[data-command]").forEach((button) => button.addEventListener("click", () => {
  if (button.dataset.suppressClick === "true") {
    delete button.dataset.suppressClick;
    return;
  }
  sendCommand(button.dataset.command, button.dataset.value === undefined ? undefined : Number(button.dataset.value));
}));

progress.addEventListener("pointerdown", (event) => {
  draggingProgress = true;
  if (progress.setPointerCapture && event.pointerId !== undefined) progress.setPointerCapture(event.pointerId);
});
progress.addEventListener("input", () => {
  $("#current-time").textContent = formatTime(Number(progress.value));
});
progress.addEventListener("change", async () => {
  clearTimeout(progressReleaseTimer);
  const result = await sendCommand("seekTo", Number(progress.value), { quietSuccess: true });
  draggingProgress = false;
  if (result.status !== "succeeded") {
    scheduleRefresh(0);
  }
});
progress.addEventListener("pointercancel", () => {
  draggingProgress = false;
  scheduleRefresh(0);
});
function releaseProgressSoon() {
  clearTimeout(progressReleaseTimer);
  progressReleaseTimer = setTimeout(() => {
    draggingProgress = false;
    scheduleRefresh(0);
  }, 250);
}
progress.addEventListener("pointerup", releaseProgressSoon);
progress.addEventListener("lostpointercapture", releaseProgressSoon);

volume.addEventListener("pointerdown", (event) => {
  draggingVolume = true;
  if (volume.setPointerCapture && event.pointerId !== undefined) volume.setPointerCapture(event.pointerId);
});
volume.addEventListener("input", () => {
  $("#volume-value").textContent = `${Math.round(Number(volume.value) * 100)}%`;
});
volume.addEventListener("change", async () => {
  clearTimeout(volumeReleaseTimer);
  const generation = ++volumeGeneration;
  const value = Number(volume.value);
  pendingVolume = value;
  draggingVolume = false;
  pendingVolumeRemainingStates = 0;
  const result = await sendCommand("volume", value, { quietSuccess: true });
  if (generation !== volumeGeneration) {
    return;
  }
  if (result.status !== "succeeded") {
    pendingVolume = null;
  } else {
    pendingVolumeRemainingStates = 3;
  }
  scheduleRefresh(0);
});
volume.addEventListener("pointercancel", () => {
  volumeGeneration += 1;
  draggingVolume = false;
  pendingVolume = null;
  scheduleRefresh(0);
});
function releaseVolumeSoon() {
  clearTimeout(volumeReleaseTimer);
  volumeReleaseTimer = setTimeout(() => {
    draggingVolume = false;
    scheduleRefresh(0);
  }, 250);
}
volume.addEventListener("pointerup", releaseVolumeSoon);
volume.addEventListener("lostpointercapture", releaseVolumeSoon);

const seekStep = $("#seek-step");
const largeMode = $("#large-mode");
seekStep.value = localStorage.getItem("videoRemoteSeekStep") || "10";
largeMode.checked = localStorage.getItem("videoRemoteLargeMode") === "true";
document.body.classList.toggle("large-controls", largeMode.checked);

function applySeekStep() {
  const seconds = Number(seekStep.value);
  $("#seek-back").dataset.value = String(-seconds);
  $("#seek-forward").dataset.value = String(seconds);
  $("#seek-back").querySelector("strong").textContent = `−${seconds}`;
  $("#seek-forward").querySelector("strong").textContent = `+${seconds}`;
}

seekStep.addEventListener("change", () => {
  localStorage.setItem("videoRemoteSeekStep", seekStep.value);
  applySeekStep();
});
largeMode.addEventListener("change", () => {
  document.body.classList.toggle("large-controls", largeMode.checked);
  localStorage.setItem("videoRemoteLargeMode", String(largeMode.checked));
});
applySeekStep();

let activeHold = null;
function stopSeekHold() {
  if (!activeHold) return;
  const button = activeHold.button;
  clearTimeout(activeHold.timer);
  activeHold = null;
  if (button.dataset.suppressClick === "true") {
    setTimeout(() => {
      delete button.dataset.suppressClick;
    }, 0);
  }
}
function startSeekHold(button, direction, event) {
  if (event.pointerType && !event.isPrimary) return;
  stopSeekHold();
  if (button.setPointerCapture && event.pointerId !== undefined) {
    button.setPointerCapture(event.pointerId);
  }
  const hold = { button, direction, held: false, timer: null };
  activeHold = hold;
  hold.timer = setTimeout(async function repeat() {
    if (activeHold !== hold || document.hidden) return;
    hold.held = true;
    button.dataset.suppressClick = "true";
    const result = await sendCommand("seekBy", direction * Number(seekStep.value), { quietSuccess: true });
    if (activeHold !== hold) {
      return;
    }
    if (result.status !== "succeeded") {
      stopSeekHold();
      return;
    }
    hold.timer = setTimeout(repeat, 180);
  }, 450);
}
document.querySelectorAll("[data-hold-seek]").forEach((button) => {
  button.addEventListener("pointerdown", (event) => startSeekHold(button, Number(button.dataset.holdSeek), event));
  button.addEventListener("pointerup", stopSeekHold);
  button.addEventListener("pointercancel", stopSeekHold);
  button.addEventListener("lostpointercapture", stopSeekHold);
  button.addEventListener("contextmenu", (event) => {
    if (button.dataset.suppressClick === "true") event.preventDefault();
  });
});
globalThis.addEventListener?.("blur", stopSeekHold);

function makeButton(label, action, disabled = false, ariaLabel = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = disabled;
  if (ariaLabel) button.setAttribute("aria-label", ariaLabel);
  button.addEventListener("click", action);
  return button;
}
function makeItem(title, subtitle) {
  const item = document.createElement("div");
  item.className = "feature-item";
  const text = document.createElement("div");
  const strong = document.createElement("strong");
  const small = document.createElement("small");
  strong.textContent = title;
  small.textContent = subtitle || "";
  text.append(strong, small);
  const actions = document.createElement("div");
  actions.className = "item-actions";
  item.append(text, actions);
  return { item, actions };
}
function showEmpty(container, message) {
  container.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "muted";
  empty.textContent = message;
  container.append(empty);
}
function renderTabRow(tab, selectedTabId, lockedTabId, connected, supportsCloseTabById) {
  const selected = tab.id === selectedTabId;
  const locked = tab.id === lockedTabId;
  const labels = [];
  if (tab.active) labels.push("窗口当前页");
  if (selected) labels.push("视频遥控目标");
  if (locked) labels.push("已锁定");
  if (tab.pinned) labels.push("已固定");
  if (tab.discarded) labels.push("已休眠");
  if (tab.incognito) labels.push("隐私窗口");
  if (!tab.hasVideo) labels.push("普通页面");
  const row = makeItem(tab.title || tab.url || "无标题标签页", labels.join(" · ") || tab.siteName);
  if (selected) row.item.classList.add("selected");
  if (tab.active) row.item.classList.add("active-tab");
  const actionLabel = tab.hasVideo && selected ? "切回视频" : "切换";
  row.actions.append(makeButton(actionLabel, () => sendCommand("selectTab", tab.id), !connected));
  if (tab.hasVideo) {
    row.actions.append(makeButton(locked ? "解锁" : "锁定", () => sendCommand("lockTab", locked ? null : tab.id), !connected));
  }
  if (Number.isInteger(tab.id) && tab.id > 0) {
    const closePending = pendingCloseTabIds.has(tab.id);
    const closeButton = makeButton("关闭", async () => {
      if (pendingCloseTabIds.has(tab.id)) return;
      pendingCloseTabIds.add(tab.id);
      Array.from(row.actions.children).forEach((button) => { button.disabled = true; });
      try {
        const result = await sendCommand("closeTab", tab.id);
        if (result.status === "succeeded") scheduleRefresh(0);
      } finally {
        pendingCloseTabIds.delete(tab.id);
        tabsSignature = "";
        scheduleRefresh(0);
      }
    }, !connected || closePending || !supportsCloseTabById, `关闭标签页：${tab.title || tab.url || "无标题"}`);
    if (!supportsCloseTabById) {
      closeButton.title = "重启本地服务并重新加载扩展后可逐项关闭";
    }
    closeButton.classList.add("tab-close");
    row.actions.append(closeButton);
    if (closePending) {
      Array.from(row.actions.children).forEach((button) => { button.disabled = true; });
    }
  }
  return row.item;
}

function renderTabs(tabs, selectedTabId, lockedTabId, connected = true, totalTabCount = tabs.length, truncated = false, catalogStatus = null, supportsCloseTabById = false) {
  const container = $("#tabs-list");
  const catalogDisplay = [catalogStatus?.status, catalogStatus?.lastError];
  const signature = JSON.stringify([tabs, selectedTabId, lockedTabId, connected, totalTabCount, truncated, catalogDisplay, supportsCloseTabById]);
  if (signature === tabsSignature) return;
  tabsSignature = signature;
  const shown = tabs.length;
  $("#tabs-status").textContent = truncated
    ? `共 ${totalTabCount} 个标签页，当前显示 ${shown} 个`
    : `全部 ${totalTabCount} 个标签页与分组`;
  if (!tabs.length) {
    if (catalogStatus?.status === "never" && connected) {
      return showEmpty(container, "尚未收到标签页列表，请在电脑的扩展管理页重新加载本扩展");
    }
    if (catalogStatus?.status === "error") {
      return showEmpty(container, `标签页同步失败：${catalogStatus.lastError || "请稍后重试"}`);
    }
    if (catalogStatus?.status === "stale") {
      return showEmpty(container, "标签页目录已过期，正在等待扩展重新同步");
    }
    if (catalogStatus?.status !== "ready") {
      return showEmpty(container, "正在等待扩展同步标签页列表");
    }
    return showEmpty(container, "浏览器中当前没有标签页");
  }
  container.replaceChildren();
  RemoteFeatures.buildTabTree(tabs).forEach((windowInfo, windowIndex) => {
    const section = document.createElement("section");
    section.className = "tab-window";
    const heading = document.createElement("h3");
    heading.textContent = `窗口 ${windowIndex + 1}`;
    section.append(heading);
    windowInfo.entries.forEach((entry, entryIndex) => {
      const groupKey = entry.group === null
        ? `${windowInfo.windowId}:ungrouped:${entryIndex}`
        : `${windowInfo.windowId}:group:${entry.group.id}`;
      const group = document.createElement("details");
      group.className = "tab-group";
      const summary = document.createElement("summary");
      if (entry.group === null) {
        summary.textContent = `未分组 · ${entry.tabs.length}`;
      } else {
        summary.textContent = `${entry.group.title || "未命名组"} · ${entry.tabs.length}`;
        summary.dataset.color = entry.group.color || "grey";
      }
      group.append(summary);
      if (tabGroupExpanded.has(groupKey)) {
        group.open = tabGroupExpanded.get(groupKey);
      } else {
        group.open = entry.group === null || !entry.group.collapsed;
      }
      group.addEventListener("toggle", () => {
        tabGroupExpanded.set(groupKey, group.open);
      });
      entry.tabs.forEach((tab) => {
        group.append(renderTabRow(tab, selectedTabId, lockedTabId, connected, supportsCloseTabById));
      });
      section.append(group);
    });
    container.append(section);
  });
}
function renderEpisodes(episodes, pageUrl) {
  const container = $("#episodes-list");
  const signature = JSON.stringify([episodes, pageUrl]);
  if (signature === episodesSignature) return;
  episodesSignature = signature;
  if (!episodes.length) return showEmpty(container, "当前页面未提供分集");
  container.replaceChildren();
  episodes.slice(0, 200).forEach((episode) => {
    const row = makeItem(episode.title, episode.current ? "当前播放" : "");
    row.actions.append(makeButton(episode.current ? "当前" : "播放", () => {
      sendCommand("selectEpisode", { id: episode.id, pageUrl });
    }, episode.current));
    container.append(row.item);
  });
}

let library = { queue: [], bookmarks: [], history: [] };
let libraryBusy = false;
let libraryRequestId = 0;
async function mutateLibrary(action) {
  if (libraryBusy) {
    notify("请等待上一项操作完成");
    return null;
  }
  libraryBusy = true;
  const requestId = ++libraryRequestId;
  try {
    const result = await api("/api/library", { method: "POST", body: JSON.stringify(action) });
    if (result.seq !== undefined) {
      const outcome = await awaitCommandResult(result.seq, result.bootId, 25000);
      if (outcome.status === "succeeded") {
        stateRequestId += 1;
        scheduleRefresh(0);
      } else {
        notify(outcome.detail || "播放失败", 4200);
      }
      await refreshLibrary();
      return outcome;
    }
    if (requestId === libraryRequestId) {
      library = result;
      renderLibrary();
    }
    return result;
  } catch (error) {
    notify(error.message, 3600);
    return null;
  } finally {
    libraryBusy = false;
  }
}
async function refreshLibrary() {
  const requestId = ++libraryRequestId;
  try {
    const result = await api("/api/library");
    if (requestId === libraryRequestId) {
      library = result;
      renderLibrary();
    }
  } catch (error) {
    notify(error.message, 3600);
  }
}
function renderLibraryList(container, items, kind) {
  if (!items.length) return showEmpty(container, "暂无内容");
  container.replaceChildren();
  items.forEach((item, index) => {
    const time = item.time === undefined ? "" : formatTime(item.time);
    const subtitle = [time, item.note].filter(Boolean).join(" · ");
    const row = makeItem(item.title || item.url, subtitle);
    row.actions.append(makeButton(kind === "queue" && index === 0 ? "下一条" : "播放", () => mutateLibrary({ action: `${kind}:play`, id: item.id })));
    if (kind === "queue") {
      row.actions.append(makeButton("↑", () => mutateLibrary({ action: "queue:move", id: item.id, direction: -1 }), index === 0, "上移"));
      row.actions.append(makeButton("↓", () => mutateLibrary({ action: "queue:move", id: item.id, direction: 1 }), index === items.length - 1, "下移"));
    }
    row.actions.append(makeButton("移除", () => mutateLibrary({ action: `${kind}:remove`, id: item.id })));
    container.append(row.item);
  });
}
function renderLibrary() {
  renderLibraryList($("#queue-list"), library.queue || [], "queue");
  renderLibraryList($("#bookmarks-list"), library.bookmarks || [], "bookmarks");
  renderLibraryList($("#history-list"), library.history || [], "history");
}
document.querySelectorAll(".feature-panel").forEach((panel) => {
  panel.addEventListener("toggle", () => {
    if (panel.open && panel.querySelector("#queue-list, #bookmarks-list, #history-list")) refreshLibrary();
  });
});
$("#queue-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#queue-links");
  const items = RemoteFeatures.extractUrls(input.value);
  if (!items.length) return notify("没有找到有效链接");
  const result = await mutateLibrary({ action: "queue:add", items });
  if (result) input.value = "";
});
$("#bookmark-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#bookmark-note");
  const bookmark = RemoteFeatures.bookmarkFromPlayer(latestPlayer, input.value);
  if (!bookmark) return notify("当前没有可保存的视频");
  const result = await mutateLibrary({ action: "bookmarks:add", ...bookmark });
  if (result) input.value = "";
});

$("#url-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (openUrlPending) {
    return;
  }
  const input = $("#video-url");
  const submit = event.currentTarget.querySelector("button[type=submit]");
  const url = extractVideoUrl(input.value);
  if (!url) {
    notify("没有找到有效的网页链接");
    input.focus();
    return;
  }
  openUrlPending = true;
  submit.disabled = true;
  try {
    const result = await sendCommand("openUrl", url, { quietSuccess: true });
    if (result.status === "succeeded") {
      input.value = "";
      notify(result.detail || "已在电脑上打开");
    }
  } finally {
    openUrlPending = false;
    submit.disabled = false;
  }
});
$("#forget").addEventListener("click", () => {
  if (!pairingRequired) return;
  token = "";
  stateRequestId += 1;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  showPair();
});

async function loadInfo() {
  try {
    const info = await api("/api/info");
    pairingRequired = info.pairingRequired;
    if (!pairingRequired) {
      token = "";
      $("#forget").hidden = true;
      showRemote();
    } else if (token) {
      $("#forget").hidden = false;
      showRemote();
    } else {
      showPair();
    }
    return true;
  } catch {
    pairingRequired = null;
    refreshFailures += 1;
    showRemote();
    return false;
  }
}
async function initialize() {
  await loadInfo();
  scheduleRefresh(0);
}
document.addEventListener("visibilitychange", () => scheduleRefresh(document.hidden ? undefined : 0));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopSeekHold();
});
initialize();
