import { useEffect, useRef, useState } from "react";
import { useActivityFeed } from "./useActivityFeed";
import { useWebSocket } from "./useWebSocket";
import type { FeedItem } from "@/lib/types";

const MAX_ITEMS = 8;
const WS_URL = process.env["NEXT_PUBLIC_WS_URL"] ?? null;

// Max time a queued message may wait before we force a commit even if the
// browser never fires requestAnimationFrame (e.g. background tabs).
const MAX_LATENCY_MS = 100;

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

// Batches incoming messages so a burst of WebSocket frames commits a single
// state update per animation frame (or per MAX_LATENCY_MS when rAF is paused
// in background tabs). Ordering is preserved and the queue is bounded.
function createBatcher<T>(flush: (batch: T[]) => void, maxLatencyMs: number) {
  let queue: T[] = [];
  let rafId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const clearScheduled = () => {
    if (rafId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafId);
    }
    rafId = null;
    if (timerId !== null) {
      clearTimeout(timerId);
    }
    timerId = null;
  };

  const commit = () => {
    clearScheduled();
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    flush(batch);
  };

  const schedule = () => {
    if (rafId !== null || timerId !== null) return;
    if (typeof requestAnimationFrame === "function") {
      rafId = requestAnimationFrame(() => {
        rafId = null;
        commit();
      });
    }
    // Fallback for background tabs where rAF is paused.
    timerId = setTimeout(() => {
      timerId = null;
      commit();
    }, maxLatencyMs);
  };

  return {
    push(item: T) {
      queue.push(item);
      schedule();
    },
    flush: commit,
    dispose() {
      clearScheduled();
      queue = [];
    },
  };
}

// Seeds the feed from the REST snapshot (useActivityFeed) and layers live
// updates from the intents WebSocket on top, newest first, deduped by id.
export function useIntentFeed() {
  const { items: seedItems, isLoading, error } = useActivityFeed();
  const { status, lastMessage } = useWebSocket<FeedItem>(WS_URL);
  const [liveItems, setLiveItems] = useState<FeedItem[]>([]);
  const batcherRef = useRef<ReturnType<typeof createBatcher<FeedItem>> | null>(
    null,
  );

  if (batcherRef.current === null) {
    batcherRef.current = createBatcher<FeedItem>((batch) => {
      setLiveItems((prev) => mergeById([...batch.reverse(), ...prev]));
    }, MAX_LATENCY_MS);
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
    items: mergeById([...liveItems, ...seedItems]),
    isLoading,
    error,
    isLive: status === "open",
  };
}
