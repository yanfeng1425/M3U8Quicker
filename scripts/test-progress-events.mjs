import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = ts.transpileModule(
  fs.readFileSync(new URL("../src/hooks/useProgressEvent.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } },
).outputText;
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Isolate the native bridge and model React's effect commit/cleanup lifecycle.
function harness({ reject = false } = {}) {
  let dependencies;
  let cleanup;
  let pendingEffect;
  let currentCallback;
  const calls = [];
  const errors = [];
  const stableCallback = (payload) => currentCallback(payload);
  const react = {
    useEffectEvent(callback) { currentCallback = callback; return stableCallback; },
    useEffect(effect, next) {
      if (!dependencies || next.some((value, index) => value !== dependencies[index])) {
        dependencies = next;
        pendingEffect = effect;
      }
    },
  };
  const bridge = {
    listen(name, callback) {
      let resolve;
      const promise = reject
        ? Promise.reject(new Error("bridge unavailable"))
        : new Promise((done) => { resolve = done; });
      const call = { name, callback, cleanups: 0 };
      call.resolve = () => resolve(() => { call.cleanups++; });
      calls.push(call);
      return promise;
    },
  };
  const exports = {};
  vm.runInNewContext(source, {
    exports,
    require: (name) => {
      if (name === "react") return react;
      assert.equal(name, "@tauri-apps/api/event");
      return bridge;
    },
    console: { error: (...args) => errors.push(args) },
  });
  return {
    calls, errors,
    render(name, callback) {
      exports.useProgressEvent(name, callback);
      if (pendingEffect) {
        cleanup?.();
        cleanup = pendingEffect();
        pendingEffect = undefined;
      }
    },
    unmount() { cleanup?.(); cleanup = undefined; },
  };
}

for (const eventName of ["download-progress", "live-progress"]) {
  test(`${eventName}: rerenders keep one listener with the latest callback`, async () => {
    const h = harness();
    const received = [];
    h.render(eventName, (value) => received.push(["old", value]));
    h.calls[0].resolve();
    await settle();
    h.render(eventName, (value) => received.push(["current", value]));
    h.calls[0].callback({ payload: 42 });
    assert.equal(h.calls.length, 1);
    assert.deepEqual(received, [["current", 42]]);
    h.unmount();
    h.calls[0].callback({ payload: 43 });
    assert.equal(h.calls[0].cleanups, 1);
    assert.equal(received.length, 1);
  });

  test(`${eventName}: a late native registration is removed after unmount`, async () => {
    const h = harness();
    h.render(eventName, () => assert.fail("event after unmount"));
    h.unmount();
    h.calls[0].callback({ payload: 42 });
    h.calls[0].resolve();
    await settle();
    assert.equal(h.calls[0].cleanups, 1);
  });
}

test("changing the event releases the old subscription", async () => {
  const h = harness();
  const received = [];
  h.render("download-progress", () => received.push("old"));
  h.calls[0].resolve();
  await settle();
  h.render("live-progress", () => received.push("new"));
  h.calls[1].resolve();
  await settle();
  h.calls[0].callback({ payload: {} });
  h.calls[1].callback({ payload: {} });
  assert.deepEqual(received, ["new"]);
  assert.equal(h.calls[0].cleanups, 1);
  h.unmount();
  assert.equal(h.calls[1].cleanups, 1);
});

test("native registration failure is handled", async () => {
  const h = harness({ reject: true });
  h.render("download-progress", () => {});
  await settle();
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0][0], /download-progress/);
  h.unmount();
});

for (const browser of ["chrome", "firefox"]) {
  test(`${browser}: closing a tab drops only that tab's pending detections`, async () => {
    let onRequest;
    let onMessage;
    let onRemoved;
    const chrome = {
      webRequest: { onBeforeRequest: { addListener: (fn) => { onRequest = fn; } } },
      runtime: {
        lastError: { message: "content script not ready" },
        onMessage: { addListener: (fn) => { onMessage = fn; } },
      },
      tabs: {
        onRemoved: { addListener: (fn) => { onRemoved = fn; } },
        sendMessage: (_tab, _message, _options, done) => {
          if (browser === "firefox") return Promise.reject(new Error("content script not ready"));
          done();
        },
      },
    };
    vm.runInNewContext(fs.readFileSync(
      new URL(`../browser-extension/${browser}/background.js`, import.meta.url), "utf8",
    ), browser === "firefox" ? { browser: chrome } : { chrome });
    const url = "https://example.com/video.m3u8";
    onRequest({ tabId: 1, url });
    onRequest({ tabId: 2, url });
    onRemoved(1);
    for (const [tabId, expected] of [[1, []], [2, [url]]]) {
      let reply;
      const result = onMessage(
        { type: "m3u8quicker:sync-detections" }, { tab: { id: tabId } },
        (value) => { reply = value; },
      );
      if (result) reply = await result;
      assert.deepEqual(Array.from(reply.urls), expected);
    }
  });
}
