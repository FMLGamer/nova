import type { Request, Response } from 'express';

export interface SseChannel {
  send: (event: string, data: unknown) => void;
  close: () => void;
  closed: () => boolean;
}

/** Opens a server-sent-events response. Compression is skipped for /api/sse-style paths in index.ts. */
export function openSse(_req: Request, res: Response): SseChannel {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  let done = false;
  const ping = setInterval(() => {
    if (!done) res.write(': ping\n\n');
  }, 15_000);
  // The response, not the request: a request "closes" as soon as its body has been read, which for a POST
  // happens right at the start and silenced every event after the first (the assistant's endless "Thinking…").
  res.on('close', () => {
    done = true;
    clearInterval(ping);
  });
  return {
    send(event, data) {
      if (done) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      (res as Response & { flush?: () => void }).flush?.();
    },
    close() {
      if (done) return;
      done = true;
      clearInterval(ping);
      res.end();
    },
    closed: () => done,
  };
}
