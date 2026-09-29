import { useEffect, useRef, useState } from "react";
import { useMyIntents } from "./useMyIntents";
import { useWebSocket } from "./useWebSocket";
import type { FeedItem } from "@/lib/types";

const MAX_ITEMS = 200;
const WS_URL = process.env["NEXT_PUBLIC_WS_URL"] ?? null;

/**
 * Batches WebSocket messages so a burst commits a single state update per
 * animation frame, with a max-latency fallback for background tabs where rAF
 * is paused. Ordering is preserved and the queue is bounded to MAX_ITEMS.
 */
function createBatcher<T>(
  flush: (items: T[]) => void,
  { maxLatencyMs = 100 }: { maxLatencyMs?: number } = {},
) {
  let queue: T[] = [];
  let rafId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const clearScheduled = () => {
    if (rafId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafId);
    }
    if (timerId !== null) clearTimeout(timerId);
    rafId = null;
    timerId = null;
  };

  const commit = () => {
    clearScheduled();
    if (queue.length === 0) return;
    const items = queue;
    queue = [];
    flush(items);
  };

  const schedule = () => {
    if (rafId !== null || timerId !== null) return;
    if (typeof requestAnimationFrame === "function") {
      rafId = requestAnimationFrame(commit);
    }
    // Fallback for background tabs where rAF is paused.
    timerId = setTimeout(commit, maxLatencyMs);
  };

  return {
    push(item: T) {
      queue.push(item);
      if (queue.length > MAX_ITEMS) {
        queue = queue.slice(queue.length - MAX_ITEMS);
      }
      schedule();
    },
    flush: commit,
    dispose() {
      clearScheduled();
      queue = [];
    },
  };
}

function mergeById(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  const merged: FeedItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged.slice(0, MAX_ITEMS);
}

export function useMyLiveIntents(address: string | null) {
  const { intents: restIntents, isLoading, error, mutate } = useMyIntents(address);
  const { status, lastMessage } = useWebSocket<FeedItem>(address ? WS_URL : null);
  const [liveItems, setLiveItems] = useState<FeedItem[]>([]);
  const batcherRef = useRef<ReturnType<typeof createBatcher<FeedItem>> | null>(null);

  if (batcherRef.current === null) {
    batcherRef.current = createBatcher<FeedItem>((items) => {
      setLiveItems((prev) => mergeById([...items.reverse(), ...prev]));
    });
  }

  useEffect(() => {
    const batcher = batcherRef.current;
    return () => batcher?.dispose();
  }, []);

  useEffect(() => {
    if (!lastMessage) return;
    batcherRef.current?.push(lastMessage);
  }, [lastMessage]);

  return {
    intents: mergeById([...liveItems, ...restIntents]),
    isLoading,
    error,
    mutate,
    isLive: status === "open",
  };
}
