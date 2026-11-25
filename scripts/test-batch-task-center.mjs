import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const read = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");
const pause = () => new Promise((resolve) => setImmediate(resolve));

test("100 rows settle independently with three workers and retry only failed IDs", async () => {
  const source = await read("src/hooks/createDownloadBatch.ts");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const { createDownloadBatch } = await import("data:text/javascript;base64," + Buffer.from(outputText).toString("base64"));
  const requests = Array.from({ length: 100 }, (_, index) => ({
    requestId: "row-" + index, params: { url: "https://example.test/" + index },
  }));
  const results = new Map();
  const started = [];
  let active = 0;
  let maximum = 0;
  const queued = await createDownloadBatch(requests, async ({ requestId }) => {
    started.push(requestId);
    active += 1;
    maximum = Math.max(active, maximum);
    await pause();
    active -= 1;
    if (requestId === "row-0" || requestId === "row-99") throw new Error("fixture failure");
    return { id: requestId };
  }, (id, result) => results.set(id, result));

  assert.equal(maximum, 3);
  assert.equal(queued, 98);
  assert.deepEqual(started, requests.map(({ requestId }) => requestId));
  const failed = requests.filter(({ requestId }) => results.get(requestId).status === "failed");
  assert.deepEqual(failed.map(({ requestId }) => requestId), ["row-0", "row-99"]);
  const retried = await createDownloadBatch(failed, async ({ requestId }) => ({ id: requestId }),
    (id, result) => results.set(id, result));
  assert.equal(retried, 2);
  assert.equal(results.size, 100);
  for (const [id, result] of results) assert.equal(result.task.id, id);
});

const headers = "referer:https://example.test/\norigin:https://example.test";
const items = Array.from({ length: 100 }, (_, index) => ({
  url: "https://media.example.test/" + index + "?signature=" + "x".repeat(128),
  fileType: ["hls", "dash", "mp4"][index % 3],
}));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

for (const browser of ["chrome", "firefox"]) {
  async function createExtension(transport) {
    let onMessage;
    const api = {
      tabs: { onRemoved: { addListener() {} } },
      webRequest: { onBeforeRequest: { addListener() {} } },
      runtime: {
        onMessage: { addListener(handler) { onMessage = handler; } },
        sendMessage(message, callback) {
          if (browser === "chrome") {
            assert.equal(onMessage(message, { tab: { id: 1 } }, callback), true);
          } else {
            return onMessage(message, { tab: { id: 1 } });
          }
        },
      },
    };
    const window = { location: { href: "" } };
    const sandbox = vm.createContext({
      [browser === "firefox" ? "browser" : "chrome"]: api,
      window, URLSearchParams, crypto: webcrypto, AbortController, TextEncoder, TextDecoder,
      APP_BATCH_DEEP_LINK_BASE_URL: "m3u8quicker://batch-download",
      buildExtraHeaders: () => headers,
      setTimeout: (fn, delay) => setTimeout(fn, delay <= 250 ? 0 : delay),
      clearTimeout,
      fetch: (...args) => transport(window, ...args),
    });
    const dir = "browser-extension/" + browser + "/";
    vm.runInContext(await read(dir + "background.js"), sandbox);
    const content = await read(dir + "content.js");
    const start = content.indexOf("function openBatchDownloader(");
    const end = content.indexOf("function buildTargetsWithUniqueNames(", start);
    assert.ok(start >= 0 && end > start);
    const open = vm.runInContext(content.slice(start, end) + "\nopenBatchDownloader", sandbox);
    return { open, window };
  }

  test(browser + ": small batches use the original deep link", async () => {
    const { open, window } = await createExtension(() => assert.fail("unexpected loopback request"));
    assert.equal(open(items.slice(0, 2)), true);
    const url = new URL(window.location.href);
    assert.equal(url.searchParams.get("items"), items.slice(0, 2).map((item) => item.url).join("\n"));
    assert.equal(url.searchParams.get("file_types"), "hls\ndash");
    assert.equal(url.searchParams.get("extra_headers"), headers);
  });

  test(browser + ": 100 items use a short link and an authenticated local handoff", async () => {
    let calls = 0;
    let received;
    const { open, window } = await createExtension(async (host, address, options) => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 404 });
      const url = new URL(host.location.href);
      const id = url.searchParams.get("id");
      const key = url.searchParams.get("key");
      assert.equal(address, "http://127.0.0.1:47873/batch/v2/" + id);
      assert.equal(options.credentials, "omit");
      const secret = await webcrypto.subtle.importKey("raw", Buffer.from(key, "hex"), "AES-GCM", false, ["encrypt", "decrypt"]);
      const context = (kind) => encoder.encode("m3u8quicker-batch-v2:" + id + ":" + kind);
      const plaintext = await webcrypto.subtle.decrypt({
        name: "AES-GCM", iv: options.body.slice(0, 12), additionalData: context("payload"),
      }, secret, options.body.slice(12));
      received = JSON.parse(decoder.decode(plaintext));
      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await webcrypto.subtle.encrypt({
        name: "AES-GCM", iv, additionalData: context("receipt"),
      }, secret, encoder.encode("accepted"));
      const receipt = Buffer.concat([iv, Buffer.from(ciphertext)]);
      return new Response(receipt, { headers: { "Content-Length": String(receipt.length) } });
    });
    const legacy = "m3u8quicker://batch-download?" + new URLSearchParams({
      items: items.map((item) => item.url).join("\n"),
      file_types: items.map((item) => item.fileType).join("\n"),
      extra_headers: headers,
    });
    assert.ok(legacy.length > 1800);
    assert.equal(await open(items), true);
    assert.ok(window.location.href.length < 200);
    assert.equal(new URL(window.location.href).searchParams.get("version"), "2");
    assert.equal(calls, 2);
    assert.deepEqual(received, {
      items: items.map(({ url, fileType }) => ({ input: url, file_type: fileType })),
      extra_headers: headers,
    });
  });

  test(browser + ": oversized batches stay in the extension", async () => {
    const { open, window } = await createExtension(() => assert.fail("unexpected loopback request"));
    assert.equal(open(Array.from({ length: 501 }, () => items[0])), "too-large");
    assert.equal(window.location.href, "");
  });
}
