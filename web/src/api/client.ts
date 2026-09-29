import type {
  ActivityResponse,
  AddMemberBody,
  ApiErrorBody,
  ApiErrorCode,
  BalancesResponse,
  ClaimResponse,
  CreateExpenseBody,
  ExpensePreviewBody,
  CreateSettlementBody,
  CreateTripBody,
  ExpensePreviewResponse,
  ExpenseProblem,
  ExpenseRef,
  ExpenseResponse,
  ExpenseStatus,
  ExpensesResponse,
  ExpenseWriteResponse,
  GroupResponse,
  MyGroupsResponse,
  MemberResponse,
  PatchTripBody,
  ResetLinkResponse,
  SaveExpenseBody,
  SettlementResponse,
  TripResponse,
  TripsResponse,
} from './types';

/** Kinds of activity the Activity screen can filter by. */
export type ActivityKind = 'expenses' | 'payments' | 'people' | 'trip';

/** A request the server refused, or that never reached it. `message` is fit to show. */
export class ApiError extends Error {
  /** 0 when the server could not be reached. */
  readonly status: number;
  readonly code: ApiErrorCode | 'network';
  readonly problems: ExpenseProblem[];
  readonly expenses: ExpenseRef[];
  /** With status 409: the record as it is now. */
  readonly current: unknown;

  constructor(status: number, code: ApiErrorCode | 'network', message: string, details: { problems?: ExpenseProblem[]; expenses?: ExpenseRef[]; current?: unknown } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.problems = details.problems ?? [];
    this.expenses = details.expenses ?? [];
    this.current = details.current;
  }

  /** Someone else changed the record since it was loaded. */
  get stale(): boolean {
    return this.status === 409;
  }
}

/** What to show for anything that was thrown. */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}

export interface ApiClient {
  /** Any route, for the ones that have no function of their own here. */
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** Replaces the start parameter, after the link was reset. */
  setLaunch(launch: string): void;

  getMyGroups(): Promise<MyGroupsResponse>;
  getGroup(): Promise<GroupResponse>;
  resetLink(): Promise<ResetLinkResponse>;
  addMember(body: AddMemberBody): Promise<MemberResponse>;
  claimMember(memberId: number): Promise<ClaimResponse>;
  /** With `entity`: only the entries about that one expense or settlement. */
  listActivity(options?: { tripId?: number; before?: number; entity?: { type: 'expense' | 'settlement'; id: number }; kind?: ActivityKind; actor?: number; limit?: number }): Promise<ActivityResponse>;

  listTrips(): Promise<TripsResponse>;
  createTrip(body?: CreateTripBody): Promise<TripResponse>;
  getTrip(tripId: number): Promise<TripResponse>;
  patchTrip(tripId: number, body: PatchTripBody): Promise<TripResponse>;
  endTrip(tripId: number): Promise<TripResponse>;
  reopenTrip(tripId: number): Promise<TripResponse>;

  listExpenses(tripId: number, status?: ExpenseStatus[]): Promise<ExpensesResponse>;
  /** `tripId` "active": the group's active trip, started first when there is none. */
  createExpense(tripId: number | 'active', body: CreateExpenseBody): Promise<ExpenseWriteResponse>;
  /** What each person would pay for an expense that is not saved yet. Changes nothing. */
  previewExpense(body: ExpensePreviewBody): Promise<ExpensePreviewResponse>;
  getExpense(id: number): Promise<ExpenseResponse>;
  lookupPlace(lat: number, lng: number): Promise<{ name: string | null }>;
  uploadPhoto(expenseId: number, photo: Blob): Promise<{ id: number; width: number; height: number }>;
  removePhoto(id: number): Promise<void>;
  photoBlob(path: string): Promise<Blob>;
  saveExpense(id: number, body: SaveExpenseBody): Promise<ExpenseWriteResponse>;
  confirmExpense(id: number, version: number): Promise<ExpenseResponse>;
  discardExpense(id: number, version: number): Promise<ExpenseResponse>;
  deleteExpense(id: number, version: number): Promise<ExpenseResponse>;
  restoreExpense(id: number, version: number): Promise<ExpenseResponse>;

  getBalances(tripId: number): Promise<BalancesResponse>;
  createSettlement(tripId: number, body: CreateSettlementBody): Promise<SettlementResponse>;
  undoSettlement(id: number, version: number): Promise<SettlementResponse>;
  restoreSettlement(id: number, version: number): Promise<SettlementResponse>;
}

export interface ApiClientOptions {
  initData: string;
  launch: string;
  /** Defaults to the page's own address. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  let launch = options.launch;
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const base = options.baseUrl ?? '';

  async function request<T>(method: string, path: string, body?: unknown, blob = false): Promise<T> {
    let response: Response;
    try {
      response = await send(`${base}${path}`, {
        method,
        headers: {
          Authorization: `tma ${options.initData}`,
          ...(path === '/api/my-groups' ? {} : { 'X-Launch': launch }),
          ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApiError(0, 'network', 'Could not reach TripSplitter. Check your connection and try again.');
    }
    if (response.ok && blob) return await response.blob() as T;
    if (response.status === 204) return undefined as T;
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const error = (parsed as ApiErrorBody | null)?.error;
      throw new ApiError(response.status, error?.code ?? 'server_error', error?.message ?? 'Something went wrong. Please try again.', {
        ...(error?.problems ? { problems: error.problems } : {}),
        ...(error?.expenses ? { expenses: error.expenses } : {}),
        current: error?.current,
      });
    }
    return parsed as T;
  }

  const query = (values: Record<string, string | number | undefined>): string => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') params.set(key, String(value));
    const text = params.toString();
    return text === '' ? '' : `?${text}`;
  };

  return {
    request,
    setLaunch: (next) => {
      launch = next;
    },

    getMyGroups: () => request('GET', '/api/my-groups'),
    getGroup: () => request('GET', '/api/group'),
    resetLink: () => request('POST', '/api/group/reset-link'),
    addMember: (body) => request('POST', '/api/members', body),
    claimMember: (memberId) => request('POST', `/api/members/${memberId}/claim`),
    listActivity: (o = {}) => request('GET', `/api/activity${query({ tripId: o.tripId, before: o.before, entityType: o.entity?.type, entityId: o.entity?.id, kind: o.kind, actor: o.actor, limit: o.limit })}`),

    listTrips: () => request('GET', '/api/trips'),
    createTrip: (body) => request('POST', '/api/trips', body ?? {}),
    getTrip: (tripId) => request('GET', `/api/trips/${tripId}`),
    patchTrip: (tripId, body) => request('PATCH', `/api/trips/${tripId}`, body),
    endTrip: (tripId) => request('POST', `/api/trips/${tripId}/end`),
    reopenTrip: (tripId) => request('POST', `/api/trips/${tripId}/reopen`),

    listExpenses: (tripId, status) => request('GET', `/api/trips/${tripId}/expenses${query({ status: status?.join(',') })}`),
    createExpense: (tripId, body) => request('POST', `/api/trips/${tripId}/expenses`, body),
    previewExpense: (body) => request('POST', '/api/expenses/preview', body),
    getExpense: (id) => request('GET', `/api/expenses/${id}`),
    lookupPlace: (lat, lng) => request('POST', '/api/places/lookup', { lat, lng }),
    uploadPhoto: (id, photo) => {
      const form = new FormData();
      form.append('photo', photo, 'photo.jpg');
      return request('POST', `/api/expenses/${id}/photos`, form);
    },
    removePhoto: id => request('DELETE', `/api/photos/${id}`),
    photoBlob: path => request('GET', path, undefined, true),
    saveExpense: (id, body) => request('PUT', `/api/expenses/${id}`, body),
    confirmExpense: (id, version) => request('POST', `/api/expenses/${id}/confirm`, { version }),
    discardExpense: (id, version) => request('POST', `/api/expenses/${id}/discard`, { version }),
    deleteExpense: (id, version) => request('POST', `/api/expenses/${id}/delete`, { version }),
    restoreExpense: (id, version) => request('POST', `/api/expenses/${id}/restore`, { version }),

    getBalances: (tripId) => request('GET', `/api/trips/${tripId}/balances`),
    createSettlement: (tripId, body) => request('POST', `/api/trips/${tripId}/settlements`, body),
    undoSettlement: (id, version) => request('POST', `/api/settlements/${id}/undo`, { version }),
    restoreSettlement: (id, version) => request('POST', `/api/settlements/${id}/restore`, { version }),
  };
}
