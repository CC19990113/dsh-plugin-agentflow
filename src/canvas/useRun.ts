// 跑图：POST /api/run 返回 SSE 流，这里手动解析（EventSource 只能 GET）。

import { useCallback, useRef, useState } from 'react';
import { apiUrl } from './api';
import type { RunEvent } from './types';

export function useRun(onEvent: (ev: RunEvent) => void) {
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  const run = useCallback(
    async (targets?: string[], boardId?: string | null) => {
      if (running) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);

      try {
        const url = boardId
          ? `/api/run?board=${encodeURIComponent(boardId)}`
          : '/api/run';
        const res = await fetch(apiUrl(url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(targets?.length ? { targets } : {}),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${text}`.slice(0, 200));
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';

          for (const chunk of chunks) {
            for (const line of chunk.split('\n')) {
              // 心跳行是 `: ping`，必须忽略
              if (!line.startsWith('data: ')) continue;
              try {
                onEvent(JSON.parse(line.slice(6)) as RunEvent);
              } catch {
                // 坏帧跳过，不中断整条流
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error)?.name !== 'AbortError') {
          onEvent({ type: 'run:error', error: (err as Error).message });
        }
      } finally {
        abortRef.current = null;
        setRunning(false);
      }
    },
    [onEvent, running]
  );

  return { running, run, stop };
}
