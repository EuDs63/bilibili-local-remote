import { getResponder } from "@homebridge/ciao";

export const DEFAULT_MDNS_HOSTNAME = "bedremote";

function trimTrailingDot(value) {
  return String(value || "").replace(/\.$/, "");
}

export async function startMdnsAdvertisement({
  port,
  addresses,
  hostname = DEFAULT_MDNS_HOSTNAME,
  version = "unknown",
  responderFactory = getResponder,
} = {}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("mDNS 端口无效");
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new TypeError("mDNS 至少需要一个局域网地址");
  }

  const responder = responderFactory();
  const service = responder.createService({
    name: "网页视频遥控器",
    hostname,
    type: "http",
    port,
    restrictedAddresses: addresses,
    txt: {
      app: "web-video-local-remote",
      version,
    },
  });

  let advertisedHostname = hostname;
  service.on("hostname-change", (value) => {
    advertisedHostname = value;
  });

  try {
    await service.advertise();
  } catch (error) {
    await responder.shutdown().catch(() => {});
    throw error;
  }

  advertisedHostname = trimTrailingDot(service.getHostname?.() || advertisedHostname);
  let stopped = false;

  return {
    hostname: advertisedHostname,
    url: `http://${advertisedHostname}:${port}/`,
    async stop() {
      if (stopped) return;
      stopped = true;
      await responder.shutdown();
    },
  };
}
