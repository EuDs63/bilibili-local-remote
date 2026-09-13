import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../docs/app.js", import.meta.url), "utf8");
const context = { URL };
context.globalThis = context;
vm.runInNewContext(source, context);
const finder = context.RemoteFinder;

test("finder accepts private IPv4 networks and complete addresses", () => {
  const network = finder.parseTarget("192.168.1");
  assert.equal(network.network, "192.168.1");
  assert.equal(network.addresses.length, 254);
  assert.equal(network.addresses[0], "192.168.1.1");
  assert.equal(network.addresses[253], "192.168.1.254");

  const address = finder.parseTarget("http://10.20.30.40:17331/");
  assert.equal(address.network, "10.20.30");
  assert.deepEqual(Array.from(address.addresses), ["10.20.30.40"]);
  assert.equal(finder.parseTarget("8.8.8"), null);
  assert.equal(finder.parseTarget("192.168.999"), null);
});

test("finder prioritizes the last successful address", () => {
  assert.deepEqual(
    Array.from(finder.prioritizeAddress(["192.168.1.1", "192.168.1.2", "192.168.1.3"], "192.168.1.2")),
    ["192.168.1.2", "192.168.1.1", "192.168.1.3"],
  );
});

test("finder stops after a probe identifies the service", async () => {
  const checked = [];
  const found = await finder.findService(
    ["192.168.1.1", "192.168.1.2", "192.168.1.3"],
    async (address) => {
      checked.push(address);
      return address === "192.168.1.2";
    },
    { concurrency: 1 },
  );
  assert.equal(found, "192.168.1.2");
  assert.deepEqual(checked, ["192.168.1.1", "192.168.1.2"]);
});
