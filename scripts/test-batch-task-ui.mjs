import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preview } from "vite";

// Run with Node 24 and a Playwright module installed outside the project if needed.
const { chromium } = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : "playwright");
const server = await preview({ preview: { host: "127.0.0.1", port: 1438, strictPort: true } });
let browser;

try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const handlers = new Map();
    const callbacks = new Map();
    let callbackId = 0;
    let rejectRefresh = true;
    const state = { calls: [], drafts: 0, release: null };
    window.batchTest = state;
    const initialDraft = {
      items: Array.from({ length: 100 }, (_, index) => ({
        input: "https://example.test/resource-" + index,
        file_type: ["hls", "dash", "mp4"][index % 3],
      })),
      extra_headers: "referer:https://example.test/",
    };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback(fn) { const id = ++callbackId; callbacks.set(id, fn); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      invoke: async (command, args = {}) => {
        if (command === "plugin:event|listen") {
          const id = ++callbackId;
          handlers.set(id, { event: args.event, handler: args.handler });
          return id;
        }
        if (command === "plugin:event|unlisten") return handlers.delete(args.eventId);
        if (command === "plugin:deep-link|get_current") return [];
        if (command === "get_app_language") return "en";
        if (command === "get_app_settings") return { history_page_size: 50, proxy: { enabled: false, url: "" } };
        if (command === "get_default_download_dir") return "C:/batch-fixture";
        if (command === "get_download_counts" || command === "get_live_record_counts") {
          if (command === "get_download_counts" && state.calls.length && rejectRefresh) {
            rejectRefresh = false;
            throw new Error("fixture refresh failure");
          }
          return { active_count: 0, history_count: 0 };
        }
        if (command === "get_downloads_page" || command === "get_live_records_page") {
          return { items: [], total: 0, page: 1, page_size: 50 };
        }
        if (command === "await_batch_handoff") {
          state.drafts += 1;
          return initialDraft;
        }
        if (command === "create_batch_download") {
          state.calls.push(args);
          if (state.calls.length === 1) await new Promise((resolve) => { state.release = resolve; });
          if (args.params.url.endsWith("/resource-0")) throw new Error("fixture row failure");
          return { id: args.requestId };
        }
        return null;
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(_event, id) { handlers.delete(id); },
    };
    state.emit = (url) => {
      for (const [id, listener] of handlers) {
        if (listener.event === "deep-link://new-url") {
          callbacks.get(listener.handler)?.({ event: listener.event, id, payload: [url] });
        }
      }
    };
    state.listening = () => [...handlers.values()].some((listener) => listener.event === "deep-link://new-url");
  });
  await page.goto(server.resolvedUrls.local[0], { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.batchTest.listening());

  await page.evaluate(() => {
    window.batchTest.emit("m3u8quicker://batch-download?items=https%3A%2F%2Fexample.test%2Fexisting.m3u8");
  });
  const modal = page.locator(".ant-modal").filter({ hasText: "Batch download" });
  const input = modal.locator("textarea").first();
  await modal.waitFor().catch(async (error) => {
    console.error("Browser errors:", errors, "Page:", (await page.locator("body").innerText()).slice(0, 1200));
    throw error;
  });
  assert.equal(await input.inputValue(), "https://example.test/existing.m3u8");
  await page.evaluate(() => {
    window.batchTest.emit("m3u8quicker://batch-download?version=2&id=" + "a".repeat(32) + "&key=" + "b".repeat(64));
  });
  await page.waitForFunction(() => window.batchTest.drafts === 1);
  assert.equal(await input.inputValue(), "https://example.test/existing.m3u8");
  assert.equal(await page.evaluate(() => window.batchTest.calls.length), 0);
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".ant-modal textarea")?.value.includes("resource-99"));
  assert.equal((await input.inputValue()).split("\n").length, 100);
  const headers = modal.locator("textarea").nth(1);
  assert.equal(await headers.inputValue(), "referer:https://example.test/");
  await input.fill((await input.inputValue()) + "\ninvalid");

  const submit = modal.getByRole("button", { name: "Start batch download", exact: true });
  await submit.dblclick();
  await page.waitForFunction(() => typeof window.batchTest.release === "function");
  assert.equal(await input.isDisabled(), true);
  await page.evaluate(() => window.batchTest.release());
  const retry = modal.getByRole("button", { name: "Retry failed items" });
  await retry.waitFor();
  const refreshWarning = page.getByText("Tasks were submitted, but the list could not refresh.", { exact: true });
  await refreshWarning.waitFor();
  const firstRequests = await page.evaluate(() => window.batchTest.calls);
  assert.equal(firstRequests.length, 100);
  assert.equal(new Set(firstRequests.map((call) => call.requestId)).size, 100);
  assert.deepEqual(firstRequests.slice(0, 3).map((call) => call.params.file_type), ["hls", "dash", "mp4"]);
  assert.equal(await modal.getByText("Queued", { exact: true }).count(), 99);
  assert.equal(await modal.getByText("Invalid", { exact: true }).count(), 1);

  const failed = modal.locator("input").filter({ visible: true }).and(modal.locator('input[value="https://example.test/resource-0"]'));
  await failed.fill("https://example.test/repaired");
  await retry.click();
  await page.waitForFunction(() => window.batchTest.calls.length === 101);
  const finalRequest = await page.evaluate(() => window.batchTest.calls.at(-1));
  assert.equal(finalRequest.requestId, firstRequests[0].requestId);
  assert.equal(finalRequest.params.url, "https://example.test/repaired");
  await modal.getByText("Queued", { exact: true }).first().waitFor();
  assert.equal(await modal.getByText("Queued", { exact: true }).count(), 100);

  await modal.getByRole("button", { name: "Close", exact: true }).last().click();
  await modal.waitFor({ state: "hidden" });
  const emitMedia = (action, url) => page.evaluate(({ action, url }) => {
    window.batchTest.emit("m3u8quicker://" + action + "?" + new URLSearchParams({ url }));
  }, { action, url });
  const singleUrl = "https://example.test/single.m3u8";
  await emitMedia("new-task", singleUrl);
  const single = page.locator(".new-download-form");
  await single.waitFor();
  assert.equal(await single.locator("#url").inputValue(), singleUrl);
  const singleModal = page.locator(".ant-modal").filter({ has: single });
  await singleModal.locator(".ant-modal-close").click();
  await singleModal.waitFor({ state: "hidden" });

  const liveUrl = "https://example.test/live.m3u8";
  await emitMedia("new-live-record", liveUrl);
  const live = page.locator(".ant-modal").filter({ hasText: "New live recording" });
  await live.waitFor();
  assert.equal(await live.locator("#url").inputValue(), liveUrl);
  await live.locator(".ant-modal-close").click();
  await live.waitFor({ state: "hidden" });

  await emitMedia("preview", "https://example.test/preview.m3u8");
  await page.locator(".ant-modal-confirm-title").filter({ hasText: "FFmpeg required for previews" }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS: Edge UI batch, retry with the original UUID, and existing single, live, and preview routes");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
