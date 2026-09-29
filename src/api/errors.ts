import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { InvalidExpenseError, LaunchError } from '../core/index.js';
import { NotFoundError, PermissionError, StaleEditError, ValidationError, type Db, type ExpenseDetail, type Scope } from '../db/index.js';
import { InitDataError } from './auth.js';
import type { ApiEnv } from './context.js';
import type { ApiErrorBody } from './types.js';
import { PhotoError } from './photos.js';
import { toExpenseView } from './views.js';

export const LINK_INVALID_MESSAGE = 'This link is no longer valid. Use the latest one pinned in the group.';
export const OPEN_FROM_GROUP_MESSAGE = 'Open TripSplitter from the link pinned in your group.';

/** Refused before any operation ran: no sign-in, or no usable link. */
export class AccessError extends Error {
  readonly status: 401 | 403;
  readonly code: 'unauthorized' | 'link_invalid';

  constructor(status: 401 | 403, code: 'unauthorized' | 'link_invalid', message: string) {
    super(message);
    this.name = 'AccessError';
    this.status = status;
    this.code = code;
  }
}

function body(error: ApiErrorBody['error']): ApiErrorBody {
  return { error };
}

/** Turns whatever a route threw into a response. Only messages written for members are passed on. */
export function handleError(db: Db, error: unknown, c: Context<ApiEnv>): Response {
  if (error instanceof PhotoError) return c.json(body({ code: 'invalid_input', message: error.message }), error.status);
  if (error instanceof AccessError) return c.json(body({ code: error.code, message: error.message }), error.status);
  if (error instanceof InitDataError) {
    // The reason and the field names only. The values are personal and are never logged.
    const header = c.req.header('Authorization') ?? '';
    const fields = [...new URLSearchParams(header.replace(/^tma\s+/i, '')).keys()];
    console.warn(`Sign-in refused: ${error.reason}. Header length ${header.length}, fields: ${fields.join(',') || 'none'}.`);
    return c.json(body({ code: 'unauthorized', message: 'Could not sign you in. Close this and open it again from the group.' }), 401);
  }
  if (error instanceof LaunchError) return c.json(body({ code: 'unauthorized', message: OPEN_FROM_GROUP_MESSAGE }), 401);
  if (error instanceof NotFoundError) return c.json(body({ code: 'not_found', message: error.message }), 404);
  if (error instanceof PermissionError) return c.json(body({ code: 'forbidden', message: error.message }), 403);
  if (error instanceof StaleEditError) {
    let current: unknown = error.current;
    if (error.entityType === 'expense') {
      const caller = c.get('caller') as { scope: Scope } | undefined;
      if (caller) current = toExpenseView(db, caller.scope, error.current as ExpenseDetail);
    }
    return c.json(body({ code: 'stale', message: error.message, entityType: error.entityType, current }), 409);
  }
  if (error instanceof ValidationError) {
    return c.json(
      body({
        code: error.code,
        message: error.message,
        ...(error.problems.length > 0 ? { problems: error.problems } : {}),
        ...(error.expenses.length > 0 ? { expenses: error.expenses } : {}),
      }),
      error.code === 'photo_limit' ? 409 : 400,
    );
  }
  if (error instanceof InvalidExpenseError) {
    return c.json(body({ code: 'invalid_expense', message: error.problems[0]?.message ?? 'This expense is not valid.', problems: error.problems }), 400);
  }
  if (error instanceof HTTPException) {
    const status = error.status;
    if (status === 404) return c.json(body({ code: 'not_found', message: 'That does not exist.' }), 404);
    if (status >= 400 && status < 500) return c.json(body({ code: 'invalid_input', message: 'The request could not be read.' }), 400);
  }
  console.error('Unexpected error in the API:', error);
  return c.json(body({ code: 'server_error', message: 'Something went wrong. Please try again.' }), 500);
}
