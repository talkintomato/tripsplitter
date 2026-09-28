import type { Db, Scope, ExpenseInput, AgentProposal } from '../db/index.js';
import type { RateSuggester, Notifier } from '../core/index.js';

export interface ToolContext { db: Db; scope: Scope; suggestRate: RateSuggester; now: Date }
export type Action =
  | { kind: 'add_expense'; tripId: number; input: ExpenseInput }
  | { kind: 'edit_expense' | 'approve_draft' | 'set_expense_rate'; expenseId: number; input: ExpenseInput }
  | { kind: 'discard_draft' | 'delete_expense' | 'restore_expense'; expenseId: number }
  | { kind: 'record_payment'; tripId: number; fromMemberId: number; toMemberId: number; amount: number }
  | { kind: 'undo_payment'; settlementId: number }
  | { kind: 'add_member'; name: string }
  | { kind: 'set_trip_rate'; tripId: number; currency: string; rate: string; origin: 'suggested' | 'member'; snapshot: string }
  | { kind: 'rename_trip'; tripId: number; name: string }
  | { kind: 'end_trip' | 'reopen_trip'; tripId: number };
export interface PlannedAction { action: Action; summary: string; confirmLabel: string }
export type ToolOutcome = { kind: 'read'; data: unknown } | { kind: 'proposal'; plans: PlannedAction[] };
export interface ProposalVersions { revision: number; expenses: Record<number, number>; settlements: Record<number, number> }
export interface PreparedProposal extends Omit<AgentProposal, 'actions' | 'versions'> { actions: PlannedAction[]; versions: ProposalVersions }
/** Return notices only on the first successful commit. Phase B dispatches them after commit. */
export type AgentNotice = { [K in keyof Notifier]: { method: K; payload: Parameters<Notifier[K]>[0] } }[keyof Notifier];
export type ConfirmationResult =
  | { kind: 'done'; notices: AgentNotice[] }
  | { kind: 'not_yours' | 'expired' | 'changed' | 'already_done'; text: string }
  | { kind: 'refused'; reason: string };

export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
