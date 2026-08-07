interface Args<T> {
  intervalMs: number;
  fetcher: () => Promise<T>;
  onUpdate: (latest: T) => void;
  onError?: (err: unknown) => void;
}

export interface Poller {
  start: () => void;
  stop: () => void;
  runOnce: () => Promise<void>;
  runOnceOrThrow: () => Promise<void>;
}

export function createPoller<T>(args: Args<T>): Poller {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const tick = async () => {
    try {
      const latest = await args.fetcher();
      args.onUpdate(latest);
    } catch (err: unknown) {
      if (args.onError) args.onError(err);
    }
  };

  const runOnceOrThrow = async () => {
    const latest = await args.fetcher();
    args.onUpdate(latest);
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      void tick();
      timer = setInterval(() => void tick(), args.intervalMs);
    },
    stop: () => {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    runOnce: tick,
    runOnceOrThrow,
  };
}
