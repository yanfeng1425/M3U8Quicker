import type { DownloadProgressEvent } from "../types";

/** Coalesce only ordinary progress; lifecycle and failure changes bypass the queue. */
export function createDownloadProgressBatch(
  commit: (events: DownloadProgressEvent[]) => void,
  schedule = (callback: () => void) => setTimeout(callback, 200),
  cancel = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
) {
  const pending = new Map<string, DownloadProgressEvent>();
  const previous = new Map<string, DownloadProgressEvent>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const events = [...pending.values()];
    pending.clear();
    if (events.length) commit(events);
  };
  return {
    push(event: DownloadProgressEvent) {
      const last = previous.get(event.id);
      const ordinary = event.group === "active" && event.status === "Downloading" &&
        last?.group === event.group && last.status === event.status &&
        last.failed_segment_count === event.failed_segment_count;
      if (event.group === "history") previous.delete(event.id);
      else previous.set(event.id, event);
      if (ordinary) {
        pending.set(event.id, event);
        timer ??= schedule(flush);
      } else {
        pending.delete(event.id);
        if (!pending.size && timer !== undefined) {
          cancel(timer);
          timer = undefined;
        }
        commit([event]);
      }
    },
    dispose() {
      if (timer !== undefined) cancel(timer);
      timer = undefined;
      pending.clear();
      previous.clear();
    },
  };
}
