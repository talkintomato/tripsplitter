import type { ComponentType } from 'react';
import type { ApiClient } from '../api/client';
import type { ExpenseProblem, Member, SplitType } from '../api/types';
import { EvenSplit } from './EvenSplit';
import type { ExpenseFormState, FormPatch } from './formState';
import { PortionsSplit } from './PortionsSplit';

/** What the form hands to the body of a split type. */
export interface SplitBodyProps {
  state: ExpenseFormState;
  /** Changes any field of the expense, including the amount, the items and the adjustment figures. */
  update(patch: FormPatch): void;
  /** The people to choose from. */
  members: Member[];
  /** The typed amount in minor units. Null when it cannot be read. */
  total: number | null;
  currency: string;
  /** Each person's amount in the expense currency, or null while there is a problem. */
  amounts: Record<number, number> | null;
  problems: ExpenseProblem[];
  disabled: boolean;
  client: ApiClient;
}

export interface SplitTypeEntry {
  type: SplitType;
  /** The word on the switch. */
  label: string;
  /** The body of the form for this split type. Null: shown on the switch but not available yet. */
  Body: ComponentType<SplitBodyProps> | null;
  /** Shown under the switch when the type is not available. */
  unavailable?: string;
}

/** The order of the switch. */
export const SPLIT_ORDER: readonly SplitType[] = ['even', 'portions', 'items'];

const registry: Record<SplitType, SplitTypeEntry> = {
  even: { type: 'even', label: 'Evenly', Body: EvenSplit },
  portions: { type: 'portions', label: 'Portions', Body: PortionsSplit },
  // PRD 4 replaces this entry with its own component.
  items: { type: 'items', label: 'By item', Body: null, unavailable: 'Splitting by item is coming soon.' },
};

export function splitType(type: SplitType): SplitTypeEntry {
  return registry[type];
}

export function splitTypes(): SplitTypeEntry[] {
  return SPLIT_ORDER.map((type) => registry[type]);
}

/** Adds or replaces the body of a split type. Call it before the form is first shown. */
export function registerSplitType(entry: SplitTypeEntry): void {
  registry[entry.type] = entry;
}
