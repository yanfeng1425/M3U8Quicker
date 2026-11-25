async function sendBatchHandoff({ id, key, draft }) {
  if (!/^[a-f0-9]{32}$/.test(id) || !/^[a-f0-9]{64}$/.test(key) ||
      !Array.isArray(draft?.items) || draft.items.length < 1 || draft.items.length > 500) {
    return false;
  }
  const encoder = new TextEncoder();
  const context = (kind) => encoder.encode("m3u8quicker-batch-v2:" + id + ":" + kind);
  const data = encoder.encode(JSON.stringify(draft));
  if (data.byteLength > 2 * 1024 * 1024) return false;
  const keyBytes = Uint8Array.from(key.match(/../g), (value) => Number.parseInt(value, 16));
  const secret = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({
    name: "AES-GCM", iv, additionalData: context("payload"),
  }, secret, data);
  const packet = new Uint8Array(iv.length + encrypted.byteLength);
  packet.set(iv);
  packet.set(new Uint8Array(encrypted), iv.length);

  const endpoint = "http://127.0.0.1:47873/batch/v2/" + id;
  const deadline = Date.now() + 25_000;
  let delay = 250;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(2000, deadline - Date.now()));
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        body: packet,
      });
      if (response.status === 200) {
        if (response.headers.get("Content-Length") !== "36") return false;
        const receipt = new Uint8Array(await response.arrayBuffer());
        if (receipt.byteLength !== 36) return false;
        const opened = await crypto.subtle.decrypt({
          name: "AES-GCM", iv: receipt.slice(0, 12), additionalData: context("receipt"),
        }, secret, receipt.slice(12));
        return new TextDecoder().decode(opened) === "accepted";
      }
      if (response.status !== 404 && response.status !== 503) return false;
    } catch {
      // The desktop process may still be starting.
    } finally {
      clearTimeout(timer);
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
    delay = Math.min(2000, delay * 2);
  }
  return false;
}

const BACKGROUND_DETECT_MESSAGE = "m3u8quicker:network-detected";
const FRAME_DETECT_MESSAGE = "m3u8quicker:frame-detected";
const SYNC_DETECTIONS_MESSAGE = "m3u8quicker:sync-detections";
const STREAM_MANIFEST_PATTERN = /\.(m3u8|mpd|flv)(?:$|[?#])/i;
const STREAM_MANIFEST_REQUEST_FILTERS = ["*://*/*.m3u8*", "*://*/*.mpd*", "*://*/*.flv*"];
const MAX_PENDING_DETECTIONS = 100;
const pendingDetectionsByTab = new Map();

browser.tabs.onRemoved.addListener((tabId) => {
  pendingDetectionsByTab.delete(tabId);
});

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!shouldTrackRequest(details)) {
      return;
    }

    queueAndDispatch(details.tabId, details.url);
  },
  {
    urls: STREAM_MANIFEST_REQUEST_FILTERS
  }
);

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "m3u8quicker:batch-handoff" && sender.tab?.id >= 0) {
    return sendBatchHandoff(message).then(
      (accepted) => ({ accepted }),
      () => ({ accepted: false }),
    );
  }

  if (message.type === FRAME_DETECT_MESSAGE && sender.tab?.id >= 0) {
    queueAndDispatch(sender.tab.id, message.url);
    return;
  }

  if (message.type === SYNC_DETECTIONS_MESSAGE) {
    const tabId = sender.tab?.id ?? -1;
    return Promise.resolve({
      urls: popPendingDetections(tabId)
    });
  }
});

function shouldTrackRequest(details) {
  return details.tabId >= 0 && typeof details.url === "string" && STREAM_MANIFEST_PATTERN.test(details.url);
}

function queueAndDispatch(tabId, url) {
  if (tabId < 0 || typeof url !== "string" || !url) {
    return;
  }

  queueDetection(tabId, url);
  dispatchDetection(tabId, url);
}

function queueDetection(tabId, url) {
  const queued = pendingDetectionsByTab.get(tabId) ?? [];
  if (!queued.includes(url)) {
    queued.push(url);
    if (queued.length > MAX_PENDING_DETECTIONS) {
      queued.splice(0, queued.length - MAX_PENDING_DETECTIONS);
    }
    pendingDetectionsByTab.set(tabId, queued);
  }
}

function dispatchDetection(tabId, url) {
  browser.tabs.sendMessage(
    tabId,
    {
      type: BACKGROUND_DETECT_MESSAGE,
      url
    },
    {
      frameId: 0
    }
  ).then(() => {
    removePendingDetection(tabId, url);
  }).catch(() => {
    // content script not ready yet, detection stays in pending queue
  });
}

function popPendingDetections(tabId) {
  if (tabId < 0) {
    return [];
  }

  const queued = pendingDetectionsByTab.get(tabId) ?? [];
  pendingDetectionsByTab.delete(tabId);
  return queued;
}

function removePendingDetection(tabId, url) {
  const queued = pendingDetectionsByTab.get(tabId);
  if (!queued) {
    return;
  }

  const nextQueued = queued.filter((item) => item !== url);
  if (nextQueued.length === 0) {
    pendingDetectionsByTab.delete(tabId);
    return;
  }

  pendingDetectionsByTab.set(tabId, nextQueued);
}
