const NEXT_SELECTORS = [
  ".bpx-player-ctrl-next",
  ".bilibili-player-video-btn-next",
  ".ytp-next-button",
  "[data-uia='control-next']",
  "button[aria-label='Next']",
  "button[aria-label='下一集']",
  "button[aria-label='下一个']",
];

const PREVIOUS_SELECTORS = [
  ".bpx-player-ctrl-prev",
  ".bilibili-player-video-btn-prev",
  "[data-uia='control-previous']",
  "button[aria-label='Previous']",
  "button[aria-label='上一集']",
  "button[aria-label='上一个']",
];

const FULLSCREEN_SELECTORS = [
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
  "[aria-label='进入全屏']",
  "[aria-label='全屏']",
  "button[aria-label*='全屏']",
  "[data-title='进入全屏']",
  "[data-title='全屏']",
  "button[title*='全屏']",
];

const DANMAKU_SELECTORS = [
  ".bpx-player-dm-switch input",
  ".bpx-player-dm-switch",
  ".bui-danmaku-switch-input",
  ".bpx-player-ctrl-danmaku input",
];

function videoElement() {
  const videos = [...document.querySelectorAll("video")];
  return videos.sort((left, right) => videoScore(right) - videoScore(left))[0] || null;
}

function videoScore(video) {
  const rect = video.getBoundingClientRect();
  const visibleArea = rect.width > 0 && rect.height > 0 ? rect.width * rect.height : 0;
  return (document.pictureInPictureElement === video ? 1_000_000_000 : 0)
    + (!video.paused && !video.ended ? 100_000_000 : 0)
    + (video.readyState >= 2 ? 10_000_000 : 0)
    + visibleArea
    + (Number.isFinite(video.duration) && video.duration > 0 ? 1_000 : 0);
}

function cleanTitle() {
  const heading = document.querySelector("h1.video-title, h1[title], .video-info-title-inner, .media-title");
  const metadata = document.querySelector("meta[property='og:title'], meta[name='twitter:title']");
  const genericHeading = document.querySelector("main h1, article h1, h1");
  const value = heading?.getAttribute("title")
    || heading?.textContent
    || metadata?.getAttribute("content")
    || genericHeading?.textContent
    || document.title;
  return String(value || "网页视频")
    .replace(/_哔哩哔哩_bilibili$/i, "")
    .replace(/-哔哩哔哩$/i, "")
    .replace(/\s+-\s+YouTube$/i, "")
    .trim();
}

function siteName() {
  const metadata = document.querySelector("meta[property='og:site_name'], meta[name='application-name']");
  const value = metadata?.getAttribute("content")?.trim();
  if (value) return value;
  return location.hostname.replace(/^www\./i, "") || "网页视频";
}

function hasSelector(selectors) {
  return selectors.some((selector) => document.querySelector(selector));
}

function hasEpisodeSibling(direction) {
  const currentSelectors = [
    ".video-pod__item.active",
    ".video-pod__item[data-active='true']",
    ".ep-item.cursor",
    ".list-box li.on",
    ".bpx-player-episode-card--active",
  ];
  return currentSelectors.some((selector) => {
    const current = document.querySelector(selector);
    return Boolean(direction > 0 ? current?.nextElementSibling : current?.previousElementSibling);
  });
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
  const player = document.querySelector(".bpx-player, .bilibili-player, .bilibili-player-video, .plyr");
  player?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (clickFirst(FULLSCREEN_SELECTORS, { allowHidden: true })) return true;
  const video = videoElement();
  const target = video?.closest(".html5-video-player, .plyr, [class*='player']") || video;
  if (!target?.requestFullscreen) return false;
  try {
    await target.requestFullscreen();
    return true;
  } catch {
    return false;
  }
}

function navigateEpisode(direction) {
  if (clickFirst(direction > 0 ? NEXT_SELECTORS : PREVIOUS_SELECTORS)) return true;

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
      return clickFirst(DANMAKU_SELECTORS);
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
      siteName: siteName(),
      currentTime: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      volume: video.volume,
      muted: video.muted,
      paused: video.paused,
      playbackRate: video.playbackRate,
      url: location.href,
      capabilities: {
        danmaku: hasSelector(DANMAKU_SELECTORS),
        fullscreen: true,
        next: hasSelector(NEXT_SELECTORS) || hasEpisodeSibling(1),
        previous: hasSelector(PREVIOUS_SELECTORS) || hasEpisodeSibling(-1),
      },
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
