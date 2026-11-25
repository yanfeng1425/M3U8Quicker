import type { CreateDownloadParams, DownloadTaskSummary } from "../types";

export interface BatchDownloadRequest {
  requestId: string;
  params: CreateDownloadParams;
}

export type BatchDownloadResult =
  | { status: "queued"; task: DownloadTaskSummary }
  | { status: "failed"; error: unknown };

export function newBatchRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

export async function createDownloadBatch(
  requests: BatchDownloadRequest[],
  create: (request: BatchDownloadRequest) => Promise<DownloadTaskSummary>,
  onResult: (requestId: string, result: BatchDownloadResult) => void,
): Promise<number> {
  let next = 0;
  let queued = 0;
  const workers = Array.from({ length: Math.min(3, requests.length) }, async () => {
    while (next < requests.length) {
      const request = requests[next++];
      let result: BatchDownloadResult;
      try {
        const task = await create(request);
        queued += 1;
        result = { status: "queued", task };
      } catch (error) {
        result = { status: "failed", error };
      }
      onResult(request.requestId, result);
    }
  });
  await Promise.all(workers);
  return queued;
}
