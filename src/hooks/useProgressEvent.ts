import { useEffect, useEffectEvent } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Keep one native subscription while allowing the callback to read current state. */
export function useProgressEvent<T>(eventName: string, callback: (payload: T) => void) {
  const onEvent = useEffectEvent(callback);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    void listen<T>(eventName, (event) => {
      if (!disposed) onEvent(event.payload);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch((error) => {
      console.error(`Failed to listen for ${eventName}`, error);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [eventName]);
}
