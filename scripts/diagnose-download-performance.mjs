// Isolated frontend probe: no real downloads, settings, or native commands.
// Run with a Vite-compatible Node and a Playwright module path, for example:
// node scripts/diagnose-download-performance.mjs /absolute/path/to/playwright/index.mjs
import { createServer } from "vite";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { chromium } = await import(process.argv[2]
  ? pathToFileURL(resolve(process.argv[2])).href : "playwright");
const tracked = ["App", "DownloadList", "NewDownloadModal", "Toolbar"];
const server = await createServer({
  server: { host: "127.0.0.1", port: 1437, strictPort: true, open: false },
  plugins: [{
    name: "download-performance-probe",
    enforce: "pre",
    transform(source, id) {
      const name = tracked.find((name) => id.replaceAll("\\", "/").endsWith(`/${name}.tsx`));
      if (!name) return;
      return source.replace("  useTranslation();", `  useTranslation();
        window.__perfRenders[${JSON.stringify(name)}] = (window.__perfRenders[${JSON.stringify(name)}] || 0) + 1;`);
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 680 } });
  const errors = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
  await page.addInitScript(() => {
    window.__perfRenders = {};
    window.__perfCalls = {};
    const callbacks = new Map();
    const listeners = new Map();
    let nextId = 0;
    const created = new Date().toISOString();
    window.__perfTasks = Array.from({ length: 3 }, (_, i) => ({
      id: `perf-${i}`, filename: `performance-${i}.ts`, file_type: "hls",
      hls_output_mode: "single_stream", hls_media_kind: "mpeg_ts",
      hls_selection: null, encryption_method: null, output_dir: "C:/perf-mock",
      status: "Downloading", total_segments: 1000000, completed_segments: 0,
      failed_segment_count: 0, total_bytes: 0, speed_bytes_per_sec: 0,
      created_at: created, updated_at: created, completed_at: null,
      playback_available: false, file_path: null,
    }));
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback(fn) { const id = ++nextId; callbacks.set(id, fn); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      invoke: async (cmd, args = {}) => {
        window.__perfCalls[cmd] = (window.__perfCalls[cmd] || 0) + 1;
        if (cmd === "plugin:event|listen") {
          const id = ++nextId;
          listeners.set(id, { event: args.event, handler: args.handler });
          return id;
        }
        if (cmd === "plugin:event|unlisten") return listeners.delete(args.eventId);
        if (cmd === "get_app_language") return "en";
        if (cmd === "get_app_settings") return {
          history_page_size: 50, proxy: { enabled: false, url: "" },
          download_concurrency: 8, download_speed_limit_kbps: 0,
        };
        if (cmd === "get_download_counts") return { active_count: 3, history_count: 0 };
        if (cmd === "get_live_record_counts") return { active_count: 0, history_count: 0 };
        if (cmd === "get_downloads_page" || cmd === "get_live_records_page") {
          const items = cmd === "get_downloads_page" && args.group === "active" ? window.__perfTasks : [];
          return { items, total: items.length, page: 1, page_size: 50 };
        }
        if (cmd === "get_default_download_dir") return "C:/perf-mock";
        if (cmd === "check_for_update") return { has_update: false };
        return null;
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(_event, id) { listeners.delete(id); },
    };
    window.__perfEmit = (event, payload) => {
      for (const [id, listener] of listeners) {
        if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload });
      }
    };
    window.__perfListenerCount = () => [...listeners.values()].filter((x) => x.event === "download-progress").length;
  });
  await page.goto(server.resolvedUrls.local[0], { waitUntil: "domcontentloaded", timeout: 120000 });
  const newButton = page.locator(".toolbar-download-main-btn");
  await newButton.waitFor({ timeout: 120000 });
  console.log("Frontend ready");
  await page.waitForTimeout(2500);
  const results = [];
  for (const scenario of [
    { eventsPerSecond: 0 }, { eventsPerSecond: 3 },
    { eventsPerSecond: 30 }, { eventsPerSecond: 120 },
    { eventsPerSecond: 120, coalesceMs: 200 },
  ]) {
    console.log(`Measuring ${JSON.stringify(scenario)}`);
    await page.evaluate(({ eventsPerSecond: rate, coalesceMs }) => {
      window.__perfRenders = {};
      window.__perfFrames = [];
      window.__perfLongTasks = [];
      window.__perfSent = 0;
      window.__perfDelivered = 0;
      const pending = new Map();
      const deliver = (payload) => {
        window.__perfDelivered++;
        window.__perfEmit("download-progress", payload);
      };
      window.__perfFlushTimer = coalesceMs ? setInterval(() => {
        for (const payload of pending.values()) deliver(payload);
        pending.clear();
      }, coalesceMs) : null;
      let previous = performance.now();
      window.__perfObserve = true;
      const frame = (now) => {
        if (!window.__perfObserve) return;
        window.__perfFrames.push(now - previous);
        previous = now;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      window.__perfObserver = new PerformanceObserver((list) => {
        window.__perfLongTasks.push(...list.getEntries().map((x) => x.duration));
      });
      window.__perfObserver.observe({ type: "longtask", buffered: false });
      window.__perfTimer = rate ? setInterval(() => {
        const task = window.__perfTasks[window.__perfSent++ % 3];
        task.completed_segments++;
        task.total_bytes += 65536;
        task.speed_bytes_per_sec = 1048576;
        task.updated_at = new Date().toISOString();
        const payload = { ...task, group: "active", percentage: 0.1 };
        if (coalesceMs) pending.set(task.id, payload);
        else deliver(payload);
      }, 1000 / rate) : null;
    }, scenario);
    await newButton.click();
    await page.locator(".new-download-form").waitFor();
    // Exclude the modal's mount animation and field-reset effects from counts.
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      window.__perfObserver.takeRecords();
      window.__perfRenders = {};
      window.__perfSent = 0;
      window.__perfDelivered = 0;
      window.__perfFrames = [];
      window.__perfLongTasks = [];
      window.__perfSampleStart = performance.now();
    });
    await page.waitForTimeout(4000);
    const result = await page.evaluate(() => {
      clearInterval(window.__perfTimer);
      clearInterval(window.__perfFlushTimer);
      window.__perfObserve = false;
      window.__perfObserver.disconnect();
      const frames = window.__perfFrames.sort((a, b) => a - b);
      return {
        sampleMs: performance.now() - window.__perfSampleStart,
        sent: window.__perfSent, delivered: window.__perfDelivered, renders: window.__perfRenders,
        progressListeners: window.__perfListenerCount(),
        frameP95Ms: frames[Math.floor(frames.length * 0.95)],
        longTaskCount: window.__perfLongTasks.length,
        longTaskTotalMs: window.__perfLongTasks.reduce((sum, x) => sum + x, 0),
      };
    });
    results.push({ ...scenario, ...result });
    console.log(JSON.stringify(results.at(-1)));
    await page.locator(".ant-modal:has(.new-download-form) .ant-modal-close").click();
    await page.waitForTimeout(400);
  }
  if (process.argv[3]) {
    for (const result of results) {
      assert.equal(result.renders.NewDownloadModal || 0, 0, "ordinary progress must not render the modal");
      assert.equal(result.progressListeners, 1);
    }
    await newButton.click();
    const form = page.locator(".new-download-form");
    const url = form.locator("#url");
    const filename = form.locator("#filename");
    const headers = form.locator("#extra_headers");
    await url.fill("https://example.com/manual.m3u8");
    await filename.fill("keep-my-name");
    await headers.fill("referer:https://example.com");
    await page.evaluate(() => {
      for (let i = 0; i < 100; i++) window.__perfEmit("download-progress", { ...window.__perfTasks[i % 3], group: "active" });
    });
    await page.waitForTimeout(400);
    assert.equal(await url.inputValue(), "https://example.com/manual.m3u8");
    assert.equal(await filename.inputValue(), "keep-my-name");
    assert.equal(await headers.inputValue(), "referer:https://example.com");
    for (const name of ["first", "second"]) {
      await page.evaluate((name) => {
        const params = new URLSearchParams({ url: "https://example.com/" + name + ".m3u8", extra_headers: "referer:https://example.com/" + name });
        window.__perfEmit("deep-link://new-url", ["m3u8quicker://new-task?" + params]);
      }, name);
      await page.waitForTimeout(350);
      assert.equal(await url.inputValue(), "https://example.com/" + name + ".m3u8");
      assert.equal(await headers.inputValue(), "referer:https://example.com/" + name);
    }
    console.log("PASS: modal isolation, listener count, editable draft and successive deep links");
  }
  const report = {
    environment: "Edge headless; Vite dev; React StrictMode; mocked native bridge; 3 HLS tasks",
    notes: "Samples cover approximately 4 seconds after modal settles; sampleMs records actual duration. Rates are synthetic, not measured download rates. The coalesced scenario is a probe-only comparison, not a product change, and covers only Downloading events. No Rust, disk, network, or WebView2 timing is measured.",
    results, errors,
  };
  await writeFile(resolve(process.argv[3] || "doc/download-performance-probe.json"), JSON.stringify(report, null, 2) + "\n");
  if (errors.length) throw new Error(`Page errors: ${errors.join("; ")}`);
} finally {
  await browser?.close();
  await server.close();
}
