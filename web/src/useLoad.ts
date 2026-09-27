import { useCallback, useEffect, useRef, useState } from 'react';

export interface Loaded<T> {
  data: T | undefined;
  error: unknown;
  /** True until the first answer, and again while reloading after an error. */
  loading: boolean;
  /** Loads again, keeping what is shown until the new answer is in. */
  reload(): Promise<void>;
  /** Replaces what is shown, with what a change returned. */
  set(data: T): void;
}

/** Loads something when the screen opens and whenever `key` changes. */
export function useLoad<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(true);
  const latest = useRef(load);
  latest.current = load;
  const run = useRef(0);

  const reload = useCallback(async () => {
    const mine = (run.current += 1);
    setLoading(true);
    try {
      const result = await latest.current();
      if (run.current !== mine) return;
      setData(result);
      setError(undefined);
    } catch (problem) {
      if (run.current !== mine) return;
      setError(problem);
    } finally {
      if (run.current === mine) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setData(undefined);
    void reload();
    return () => {
      run.current += 1;
    };
  }, [key, reload]);

  return { data, error, loading, reload, set: setData };
}
