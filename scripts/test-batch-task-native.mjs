import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, webcrypto } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const filename = resolve(process.argv[3]);
const channel = process.argv[4];
assert.ok(!channel || ["chrome", "msedge"].includes(channel));
assert.ok((await readFile(filename)).includes("com.liubsyy.m3u8quicker.batchtest"),
  "Use the isolated desktop build described in doc/batch-task-center.md");
await mkdir(resolve(".tools"), { recursive: true });
const output = await mkdtemp(resolve(".tools/batch-native-output-"));
const media = Buffer.from("M3U8 Quicker direct-download fixture\n");
const tsPacket = Buffer.alloc(188, 0xff);
tsPacket.set([0x47, 0x1f, 0xff, 0x10]);
const dashSegment = Buffer.from("DASH test fragment");
const dashManifest = [
  '<MPD type="static" mediaPresentationDuration="PT1S"><Period>',
  '<AdaptationSet contentType="video" mimeType="video/mp4">',
  '<SegmentTemplate timescale="1" initialization="init.m4s" media="chunk-$Number$.m4s" startNumber="1">',
  '<SegmentTimeline><S d="1" /></SegmentTimeline></SegmentTemplate>',
  '<Representation id="0" bandwidth="2500000" width="1920" height="1080" codecs="avc1.640028" />',
  '</AdaptationSet></Period></MPD>',
].join("");
const fixtures = new Map([
  ["/fixture.m3u8", [ "application/vnd.apple.mpegurl", "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfixture.ts\n#EXT-X-ENDLIST\n"]],
  ["/fixture.ts", ["video/mp2t", tsPacket]],
  ["/fixture.mpd", ["application/dash+xml", dashManifest]],
  ["/init.m4s", ["video/mp4", Buffer.from("DASH test initialization")]],
  ["/chunk-1.m4s", ["video/mp4", dashSegment]],
]);
const server = createServer((request, response) => {
  if (request.url.startsWith("/bad.m3u8")) {
    response.writeHead(404).end();
    return;
  }
  const [type, fixture] = fixtures.get(request.url) ?? ["video/mp4", media];
  const data = Buffer.from(fixture);
  response.writeHead(200, { "content-type": type, "content-length": data.length }).end(data);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const port = 9397;
const child = spawn(filename, { windowsHide: true, env: {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + port,
}, stdio: "ignore" });
let browser;
let extensionContext;
try {
  const endpoint = "http://127.0.0.1:" + port;
  let ready = false;
  for (let count = 0; count < 100; count += 1) {
    if (child.exitCode !== null) throw new Error("Desktop exited with code " + child.exitCode);
    try {
      if ((await fetch(endpoint + "/json/version")).ok) { ready = true; break; }
    } catch {
      // The WebView debugging endpoint appears during startup.
    }
    await delay(150);
  }
  assert.ok(ready, "The isolated WebView2 did not expose its debugging endpoint");
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.waitForEvent("page");
  await page.waitForFunction(() => window.__TAURI__?.core && document.querySelector(".toolbar-download-main-btn"));
  console.log("Opened isolated native WebView2");
  await page.evaluate(async (output) => {
    await window.__TAURI__.core.invoke("set_default_download_dir", { path: output });
    await window.__TAURI__.core.invoke("set_app_language", { language: "en" });
  }, output);
  await page.reload();
  await page.waitForFunction(() => window.__TAURI__?.core && document.querySelector(".toolbar-download-main-btn"));
  const baseline = await page.evaluate(() => window.__TAURI__.core.invoke("get_download_counts"));

  const input = [
    { input: origin + "/bad.m3u8", file_type: "hls" },
    { input: origin + "/fixture.m3u8", file_type: "hls" },
    { input: origin + "/fixture.mpd", file_type: "dash" },
    ...Array.from({ length: 97 }, (_, index) => ({
      input: origin + "/fixture-" + (index + 3) + ".mp4",
      file_type: "mp4",
    })),
  ];
  let send;
  if (channel) {
    extensionContext = await chromium.launchPersistentContext("", {
      channel, headless: true,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: ["--enable-unsafe-extension-debugging"],
    });
    const extensionBrowser = extensionContext.browser();
    const session = extensionBrowser
      ? await extensionBrowser.newBrowserCDPSession()
      : await extensionContext.newCDPSession(extensionContext.pages()[0]);
    const { id: extensionId } = await session.send("Extensions.loadUnpacked", {
      path: resolve("browser-extension/chrome"),
    });
    const matches = (worker) => worker.url().startsWith("chrome-extension://" + extensionId + "/");
    const worker = extensionContext.serviceWorkers().find(matches) ??
      await extensionContext.waitForEvent("serviceworker", { predicate: matches, timeout: 5000 });
    send = (request) => worker.evaluate((data) => globalThis.sendBatchHandoff(data), request);
  } else {
    const background = await readFile(resolve("browser-extension/chrome/background.js"), "utf8");
    const fakeChrome = {
      tabs: { onRemoved: { addListener() {} } },
      runtime: { onMessage: { addListener() {} } },
      webRequest: { onBeforeRequest: { addListener() {} } },
    };
    send = vm.runInNewContext(background + "\nsendBatchHandoff", {
      chrome: fakeChrome, crypto: webcrypto, TextEncoder, TextDecoder, AbortController,
      fetch, setTimeout, clearTimeout,
    });
  }
  const id = randomBytes(16).toString("hex");
  const key = randomBytes(32).toString("hex");
  const link = "m3u8quicker://batch-download?" + new URLSearchParams({ version: "2", id, key });
  const sending = send({ id, key, draft: { items: input, extra_headers: "referer:" + origin + "/" } });
  const modal = page.locator(".ant-modal").filter({ hasText: "Batch download" });
  for (let count = 0; count < 12; count += 1) {
    await page.evaluate((link) => window.__TAURI__.event.emit("deep-link://new-url", [link]), link);
    if (await modal.isVisible()) break;
    await delay(700);
  }
  assert.equal(await sending, true, "Chromium worker source should authenticate the Rust receipt");
  await modal.waitFor();
  assert.equal((await modal.locator("textarea").first().inputValue()).split("\n").length, 100);
  const countBefore = await page.evaluate(() => window.__TAURI__.core.invoke("get_download_counts"));
  assert.equal(countBefore.active_count + countBefore.history_count, baseline.active_count + baseline.history_count);

  await modal.getByRole("button", { name: "Start batch download", exact: true }).click();
  const retry = modal.getByRole("button", { name: "Retry failed items" });
  await retry.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll(".ant-modal tbody tr")].filter(
    (row) => row.textContent.includes("Queued"),
  ).length === 99);
  const failureRow = modal.locator("tbody tr").filter({ hasText: "Queue failed" });
  await failureRow.locator('input[value="' + origin + '/bad.m3u8"]').fill(origin + "/repaired.mp4");
  await failureRow.locator(".ant-select").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").getByText("Direct", { exact: true }).click();
  await retry.click();
  await page.waitForFunction(() => [...document.querySelectorAll(".ant-modal tbody tr")].filter(
    (row) => row.textContent.includes("Queued"),
  ).length === 100);

  const ids = await modal.getByText("Queued", { exact: true }).evaluateAll((nodes) => nodes.map((node) => node.title));
  assert.equal(new Set(ids).size, 100);
  await page.waitForFunction(async (ids) => {
    const tasks = await Promise.all(ids.map((id) => window.__TAURI__.core.invoke("get_download_summary", { id })));
    return tasks.every((task) => task.status === "Completed");
  }, ids, { timeout: 60000, polling: 500 });
  const countAfter = await page.evaluate(() => window.__TAURI__.core.invoke("get_download_counts"));
  assert.equal(countAfter.active_count + countAfter.history_count, baseline.active_count + baseline.history_count + 100);
  const hls = await page.evaluate((id) => window.__TAURI__.core.invoke("get_download_summary", { id }), ids[1]);
  assert.equal(hls.file_type, "hls");
  assert.deepEqual(await readFile(hls.file_path), tsPacket);
  const dash = await page.evaluate((id) => window.__TAURI__.core.invoke("get_download_summary", { id }), ids[2]);
  assert.equal(dash.file_type, "dash");
  const track = join(dash.file_path, "video");
  const index = await readFile(join(track, "index.m3u8"), "utf8");
  const segment = index.split("\n").find((line) => line.length > 0 && !line.startsWith("#"));
  assert.deepEqual(await readFile(join(track, segment)), dashSegment);
  assert.deepEqual(await readFile(join(output, "repaired.mp4")), media);
  assert.deepEqual(await readFile(join(output, "fixture-99.mp4")), media);
  console.log("PASS: native WebView2, " + (channel ?? "Chromium background source") +
    " and Rust handoff, 100 unique completed tasks, corrected retry, and checked HLS, DASH and direct file bytes");
} finally {
  await extensionContext?.close();
  await browser?.close();
  child.kill();
  await new Promise((resolve) => server.close(resolve));
}
