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

let token = localStorage.getItem("biliRemoteToken") || "";
let pairingRequired = true;
let latestPlayer = null;
let draggingProgress = false;
let toastTimer = null;

function setView(view) {
  const remoteVisible = view === "remote";
  pairView.hidden = remoteVisible;
  pairView.style.display = remoteVisible ? "none" : "";
  remoteView.hidden = !remoteVisible;
  remoteView.style.display = remoteVisible ? "" : "none";
}

function showRemote() {
  setView("remote");
}

function showPair() {
  setView("pair");
  pairCode.focus();
}

function notify(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
}

function vibrate() {
  if (navigator.vibrate) navigator.vibrate(12);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers["X-Bili-Remote-Token"] = token;
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { ...options, headers, cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "连接失败");
  return body;
}

function normalizePairCode(value) {
  return String(value)
    .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10))
    .replace(/\D/g, "")
    .slice(0, 6);
}

function extractBilibiliUrl(value) {
  const match = String(value || "").match(/https?:\/\/(?:[a-z0-9-]+\.)*bilibili\.com\/[^\s<>"'，。！？；：、）】》]+|https?:\/\/b23\.tv\/[^\s<>"'，。！？；：、）】》]+/i);
  return match ? match[0] : "";
}

async function sendCommand(type, value) {
  vibrate();
  try {
    await api("/api/command", {
      method: "POST",
      body: JSON.stringify(value === undefined ? { type } : { type, value }),
    });
    return true;
  } catch (error) {
    notify(error.message);
    return false;
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

function renderState(state) {
  const online = state.extensionConnected && state.playerActive;
  connection.dataset.state = online ? "online" : state.extensionConnected ? "waiting" : "offline";
  connectionText.textContent = online ? "已连接" : state.extensionConnected ? "等待视频" : "扩展未连接";
  $("#hint").textContent = online
    ? "手机和电脑正在通过家中网络连接"
    : state.extensionConnected
      ? "扩展已连接，请在 Edge 中打开 B 站视频"
      : "请确认 Edge 扩展已加载，并保持本地服务开启";
  if (!state.player) return;

  latestPlayer = state.player;
  $("#video-title").textContent = state.player.title || "哔哩哔哩";
  $("#current-time").textContent = formatTime(state.player.currentTime);
  $("#duration").textContent = formatTime(state.player.duration);
  if (!draggingProgress) {
    progress.max = Math.max(1, state.player.duration || 1);
    progress.value = Math.min(state.player.currentTime || 0, Number(progress.max));
  }
  volume.value = state.player.muted ? 0 : state.player.volume;
  $("#volume-value").textContent = `${Math.round((state.player.muted ? 0 : state.player.volume) * 100)}%`;
  $("#play-icon").textContent = state.player.paused ? "▶" : "❚❚";
  $("#play-toggle").setAttribute("aria-label", state.player.paused ? "播放" : "暂停");
  $("#speed-value").textContent = `${state.player.playbackRate}×`;
  document.querySelectorAll(".speed-grid button").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.value) === state.player.playbackRate);
  });
}

async function refresh() {
  if (pairingRequired && !token) return;
  try {
    const state = await api("/api/state");
    renderState(state);
  } catch (error) {
    connection.dataset.state = "offline";
    connectionText.textContent = "服务未连接";
    if (error.message.includes("配对")) {
      token = "";
      localStorage.removeItem("biliRemoteToken");
      showPair();
    }
  }
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
    const result = await api("/api/pair", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    token = result.token;
    localStorage.setItem("biliRemoteToken", token);
    showRemote();
    refresh();
  } catch (error) {
    pairError.textContent = error.message;
    pairCode.select();
  } finally {
    pairSubmit.disabled = false;
    pairSubmit.textContent = "连接遥控器";
  }
});

pairCode.addEventListener("input", () => {
  const normalized = normalizePairCode(pairCode.value);
  if (normalized !== pairCode.value) pairCode.value = normalized;
  pairError.textContent = "";
});

document.querySelectorAll("[data-command]").forEach((button) => {
  button.addEventListener("click", () => {
    const value = button.dataset.value === undefined ? undefined : Number(button.dataset.value);
    sendCommand(button.dataset.command, value);
  });
});

progress.addEventListener("pointerdown", () => { draggingProgress = true; });
progress.addEventListener("input", () => {
  $("#current-time").textContent = formatTime(Number(progress.value));
});
progress.addEventListener("change", () => {
  draggingProgress = false;
  sendCommand("seekTo", Number(progress.value));
});
progress.addEventListener("pointerup", () => { draggingProgress = false; });

volume.addEventListener("input", () => {
  $("#volume-value").textContent = `${Math.round(Number(volume.value) * 100)}%`;
});
volume.addEventListener("change", () => sendCommand("volume", Number(volume.value)));

$("#url-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#video-url");
  const url = extractBilibiliUrl(input.value);
  if (!url) {
    notify("没有找到有效的 B 站链接");
    input.focus();
    return;
  }
  const sent = await sendCommand("openUrl", url);
  if (!sent) return;
  input.value = "";
  notify("已发送到电脑");
});

$("#forget").addEventListener("click", () => {
  if (!pairingRequired) return;
  token = "";
  localStorage.removeItem("biliRemoteToken");
  showPair();
});

async function initialize() {
  try {
    const info = await api("/api/info");
    pairingRequired = info.pairingRequired;
  } catch {
    pairingRequired = true;
  }

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
  refresh();
}

initialize();
setInterval(refresh, 1000);
