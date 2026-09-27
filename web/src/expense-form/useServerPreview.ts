import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client';
import type { ExpensePreviewBody, ExpensePreviewResponse } from '../api/types';

export interface ServerPreview {
  /**
   * `off`: nothing to ask. `loading`: the answer for what is on the screen has not arrived.
   * `ready`: `result` belongs to what is on the screen. `failed`: the server could not be asked, or refused.
   */
  status: 'off' | 'loading' | 'ready' | 'failed';
  /** The last answer received. While loading it belongs to an earlier version of the expense. */
  result: ExpensePreviewResponse | null;
  /** Only with `failed`. */
  error: unknown;
  retry(): void;
}

/** How long to wait after the last change before asking, so that fast tapping asks once. */
export const PREVIEW_DELAY_MS = 150;

/** The part of an expense that decides who pays what. A change anywhere else needs no new answer. */
function splitKey(input: ExpensePreviewBody): string {
  const { description: _description, merchant: _merchant, expenseDate: _date, items, ...rest } = input;
  return JSON.stringify({ ...rest, items: (items ?? []).map((item) => ({ amount: item.amount, shares: item.shares ?? [] })) });
}

/**
 * Asks the server what each person would pay, again after every change that matters.
 * Pass null while there is nothing to ask, such as an amount that cannot be read.
 */
export function useServerPreview(client: ApiClient, input: ExpensePreviewBody | null): ServerPreview {
  const key = input === null ? null : splitKey(input);
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{ key: string; attempt: number; result?: ExpensePreviewResponse; error?: unknown } | null>(null);
  const [last, setLast] = useState<ExpensePreviewResponse | null>(null);
  const latest = useRef(input);
  latest.current = input;
  const asked = useRef(false);

  useEffect(() => {
    if (key === null) return undefined;
    let dropped = false;
    const ask = (): void => {
      const body = latest.current;
      if (body === null) return;
      client.previewExpense(body).then(
        (result) => {
          if (dropped) return;
          setLast(result);
          setAnswer({ key, attempt, result });
        },
        (error: unknown) => {
          if (!dropped) setAnswer({ key, attempt, error });
        },
      );
    };
    // The first question is asked at once. Later ones wait for the tapping to pause.
    const timer = setTimeout(ask, asked.current ? PREVIEW_DELAY_MS : 0);
    asked.current = true;
    return () => {
      dropped = true;
      clearTimeout(timer);
    };
  }, [client, key, attempt]);

  const retry = (): void => setAttempt((n) => n + 1);
  if (key === null) return { status: 'off', result: null, error: undefined, retry };
  if (answer === null || answer.key !== key || answer.attempt !== attempt) return { status: 'loading', result: last, error: undefined, retry };
  if (answer.result === undefined) return { status: 'failed', result: last, error: answer.error, retry };
  return { status: 'ready', result: answer.result, error: undefined, retry };
}
