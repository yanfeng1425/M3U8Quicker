import { useEffect, useEffectEvent, useRef } from "react";
import type { DownloadProgressEvent } from "../types";
import { createDownloadProgressBatch } from "./downloadProgressBatch";
import { useProgressEvent } from "./useProgressEvent";

export function useDownloadProgress(callback: (events: DownloadProgressEvent[]) => void) {
  const onBatch = useEffectEvent(callback);
  const batch = useRef<ReturnType<typeof createDownloadProgressBatch> | null>(null);
  useEffect(() => {
    const current = createDownloadProgressBatch((events) => onBatch(events));
    batch.current = current;
    return () => {
      current.dispose();
      batch.current = null;
    };
  }, []);
  useProgressEvent<DownloadProgressEvent>("download-progress", (event) => batch.current?.push(event));
}
