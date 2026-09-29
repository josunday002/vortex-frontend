import { useEffect, useRef, useState } from "react";
import { useIntents } from "./useIntents";
import { useWebSocket } from "./useWebSocket";
import type { FeedItem } from "@/lib/types";

const MAX_ITEMS = 200;
const WS_URL = process.env["NEXT_PUBLIC_WS_URL"] ?? null;

// Max time a queued message may wait before we force a commit even if no
// animation frame has fired (e.g. background tabs where rAF is paused).
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

// Batches WebSocket frames so a burst of messages commits to state once per
// animation frame (or once per MAX_LATENCY_MS when rAF is paused). Ordering
// is preserved because the queue is drained in arrival order.
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
      timerId = null;
    }
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
      rafId = requestAnimationFrame(commit);
    }
    // Fallback for background tabs where rAF is paused.
    timerId = setTimeout(commit, maxLatencyMs);
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

// Like useIntentFeed, but sized for the full explore browse view rather
// than the homepage's small preview list.
export function useLiveIntents() {
  const { intents: restIntents, isLoading, error } = useIntents();
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
    intents: mergeById([...liveItems, ...restIntents]),
    isLoading,
    error,
    isLive: status === "open",
  };
}
