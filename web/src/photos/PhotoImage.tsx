import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';

/** All authenticated and local images share one object URL lifecycle. */
export function PhotoImage({ client, source, alt }: { client: ApiClient; source: string | Blob; alt: string }) {
  const [loaded, setLoaded] = useState<{ source: string | Blob; url: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    setFailed(false);
    setLoaded(null);
    void (async () => {
      try {
        const blob = typeof source === 'string' ? await client.photoBlob(source) : source;
        if (!active) return;
        url = URL.createObjectURL(blob);
        setLoaded({ source, url });
      } catch { if (active) setFailed(true); }
    })();
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [client, source, attempt]);
  if (failed) return <span className="photo-failed" role="status">Photo unavailable <button type="button" className="link-btn" aria-label={`Retry loading ${alt}`} onClick={event => { event.stopPropagation(); setAttempt(n => n + 1); }}>Retry</button></span>;
  if (!loaded || loaded.source !== source) return <span className="sk photo-skeleton" role="status" aria-label={`Loading ${alt}`} />;
  return <img src={loaded.url} alt={alt} onError={() => setFailed(true)} />;
}
