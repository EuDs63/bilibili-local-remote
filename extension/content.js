function videoElement() {
  const videos = [...document.querySelectorAll("video")];
  return videos.find((video) => video.duration > 0 && video.offsetWidth > 0) || videos[0] || null;
}

function cleanTitle() {
  const heading = document.querySelector("h1.video-title, h1[title], .video-info-title-inner, .media-title");
  const value = heading?.getAttribute("title") || heading?.textContent || document.title;
  return String(value || "哔哩哔哩")
    .replace(/_哔哩哔哩_bilibili$/i, "")
    .replace(/-哔哩哔哩$/i, "")
    .trim();
}

function clickFirst(selectors, { allowHidden = false } = {}) {
  const hiddenCandidates = [];
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!(element instanceof HTMLElement)) continue;
      if (element.offsetParent !== null || element.getClientRects().length > 0) {
        element.click();
        return true;
      }
      if (allowHidden && hiddenCandidates.length === 0) hiddenCandidates.push(element);
    }
  }
  if (hiddenCandidates.length > 0) {
    hiddenCandidates[0].click();
    return true;
  }
  return false;
}

async function clickPlayerFullscreen() {
  window.focus();
  const player = document.querySelector(".bpx-player, .bilibili-player, .bilibili-player-video");
  player?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  return clickFirst([
    ".bpx-player-ctrl-full",
    ".bpx-player-ctrl-fullscreen",
    ".bilibili-player-video-btn-fullscreen",
    ".squirtle-video-fullscreen",
    "[aria-label='进入全屏']",
    "[aria-label='全屏']",
    "[data-title='进入全屏']",
    "[data-title='全屏']",
    "[title='全屏']",
  ], { allowHidden: true });
}

function navigateEpisode(direction) {
  if (direction > 0 && clickFirst([
    ".bpx-player-ctrl-next",
    ".bilibili-player-video-btn-next",
    "[aria-label='下一个']",
    "[aria-label='下一集']",
  ])) return true;

  const currentSelectors = [
    ".video-pod__item.active",
    ".video-pod__item[data-active='true']",
    ".ep-item.cursor",
    ".list-box li.on",
    ".bpx-player-episode-card--active",
  ];
  for (const selector of currentSelectors) {
    const current = document.querySelector(selector);
    if (!current) continue;
    const sibling = direction > 0 ? current.nextElementSibling : current.previousElementSibling;
    const clickable = sibling?.matches("a") ? sibling : sibling?.querySelector("a, button, [role='button']") || sibling;
    if (clickable instanceof HTMLElement) {
      clickable.click();
      return true;
    }
  }
  return false;
}

async function execute(command) {
  const video = videoElement();
  if (!video && !["next", "previous", "fullscreen", "webFullscreen", "toggleDanmaku"].includes(command.type)) return false;

  switch (command.type) {
    case "toggle":
      if (video.paused) await video.play(); else video.pause();
      return true;
    case "play":
      await video.play();
      return true;
    case "pause":
      video.pause();
      return true;
    case "seekBy":
      video.currentTime = Math.min(video.duration || Infinity, Math.max(0, video.currentTime + command.value));
      return true;
    case "seekTo":
      video.currentTime = Math.min(video.duration || Infinity, Math.max(0, command.value));
      return true;
    case "volume":
      video.volume = Math.min(1, Math.max(0, command.value));
      video.muted = false;
      return true;
    case "mute":
      video.muted = !video.muted;
      return true;
    case "speed":
      video.playbackRate = command.value;
      return true;
    case "toggleDanmaku":
      return clickFirst([
        ".bpx-player-dm-switch input",
        ".bpx-player-dm-switch",
        ".bui-danmaku-switch-input",
        ".bpx-player-ctrl-danmaku input",
      ]);
    case "fullscreen":
    case "webFullscreen":
      return clickPlayerFullscreen();
    case "next":
      return navigateEpisode(1);
    case "previous":
      return navigateEpisode(-1);
    default:
      return false;
  }
}

function reportState() {
  const video = videoElement();
  if (!video) return;
  chrome.runtime.sendMessage({
    kind: "player-state",
    state: {
      title: cleanTitle(),
      currentTime: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      volume: video.volume,
      muted: video.muted,
      paused: video.paused,
      playbackRate: video.playbackRate,
      url: location.href,
    },
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.kind !== "remote-command") return;
  execute(message.command)
    .then((handled) => { reportState(); sendResponse({ handled }); })
    .catch(() => sendResponse({ handled: false }));
  return true;
});

reportState();
setInterval(reportState, 1000);
