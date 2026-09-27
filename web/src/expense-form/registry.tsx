import type { ComponentType } from 'react';
import type { ApiClient } from '../api/client';
import type { ExpensePreviewResponse, ExpenseProblem, Member, SplitType } from '../api/types';
import { EvenSplit } from './EvenSplit';
import type { ExpenseFormState, FormPatch } from './formState';
import { PortionsSplit } from './PortionsSplit';
import { ItemFigures, ItemsSplit } from '../split-items/ItemsSplit';

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
  /**
   * Each person's amount in the expense currency, or null while there is a problem.
   * While `pending` is true these are the amounts and problems of a moment ago.
   */
  amounts: Record<number, number> | null;
  corrections?: ExpensePreviewResponse['corrections'];
  problems: ExpenseProblem[];
  disabled: boolean;
  client: ApiClient;
  /** Only with `serverPreview`: the answer for what is on the screen has not arrived yet. */
  pending?: boolean;
  /** Only with `serverPreview`: why the amounts could not be worked out. Undefined when they could. */
  previewError?: unknown;
  /** Only with `serverPreview`: asks again after `previewError`. */
  retryPreview?(): void;
  /** The person using the app, to mark as "you". */
  meId?: number;
}

export interface SplitTypeEntry {
  type: SplitType;
  /** The word on the switch. */
  label: string;
  /** The body of the form for this split type. Null: shown on the switch but not available yet. */
  Body: ComponentType<SplitBodyProps> | null;
  /** Figures this split type uses that are needed less often, shown under More options. */
  Extras?: ComponentType<SplitBodyProps>;
  /** Shown under the switch when the type is not available. */
  unavailable?: string;
  /**
   * True: the amounts and problems come from `POST /api/expenses/preview`, and Save is off until that
   * answer says there is no problem. All split types use server amounts.
   */
  serverPreview?: boolean;
}

/** The order of the switch. */
export const SPLIT_ORDER: readonly SplitType[] = ['even', 'portions', 'items'];

const registry: Record<SplitType, SplitTypeEntry> = {
  even: { type: 'even', label: 'Equally', Body: EvenSplit },
  portions: { type: 'portions', label: 'Portions', Body: PortionsSplit },
  items: { type: 'items', label: 'By item', Body: ItemsSplit, Extras: ItemFigures, serverPreview: true },
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
