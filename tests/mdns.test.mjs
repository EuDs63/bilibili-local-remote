import assert from "node:assert/strict";
import test from "node:test";
import { startMdnsAdvertisement } from "../mdns.mjs";

function fakeResponder({ advertisedHostname = "bedremote.local.", advertiseError = null } = {}) {
  let shutdownCalls = 0;
  let options = null;
  const listeners = new Map();
  const service = {
    on(event, listener) {
      listeners.set(event, listener);
      return this;
    },
    async advertise() {
      if (advertiseError) throw advertiseError;
    },
    getHostname() {
      return advertisedHostname;
    },
  };
  const responder = {
    createService(value) {
      options = value;
      return service;
    },
    async shutdown() {
      shutdownCalls += 1;
    },
  };
  return {
    responder,
    state: {
      get options() { return options; },
      get shutdownCalls() { return shutdownCalls; },
      listeners,
    },
  };
}

test("advertises the HTTP service on the selected LAN addresses", async () => {
  const fake = fakeResponder();
  const advertisement = await startMdnsAdvertisement({
    port: 17331,
    addresses: ["192.168.1.23"],
    version: "test",
    responderFactory: () => fake.responder,
  });

  assert.deepEqual(fake.state.options, {
    name: "网页视频遥控器",
    hostname: "bedremote",
    type: "http",
    port: 17331,
    restrictedAddresses: ["192.168.1.23"],
    txt: { app: "web-video-local-remote", version: "test" },
  });
  assert.equal(advertisement.hostname, "bedremote.local");
  assert.equal(advertisement.url, "http://bedremote.local:17331/");

  await advertisement.stop();
  await advertisement.stop();
  assert.equal(fake.state.shutdownCalls, 1);
});

test("shuts the responder down when advertising fails", async () => {
  const fake = fakeResponder({ advertiseError: new Error("socket failed") });
  await assert.rejects(
    startMdnsAdvertisement({
      port: 17331,
      addresses: ["192.168.1.23"],
      responderFactory: () => fake.responder,
    }),
    /socket failed/,
  );
  assert.equal(fake.state.shutdownCalls, 1);
});
