import { createContext, useContext } from 'react';
import type { ApiClient } from './api/client';
import type { GroupResponse, Member } from './api/types';

export interface AppState {
  client: ApiClient;
  allGroups?(): void;
  /** The group as last loaded: members, the caller, the active trip. */
  group: GroupResponse;
  /** Loads the group again, after members or trips changed. */
  refresh(): Promise<GroupResponse>;
  /** Replaces the group with what a request returned. */
  setGroup(update: (current: GroupResponse) => GroupResponse): void;
}

const AppContext = createContext<AppState | null>(null);

export const AppProvider = AppContext.Provider;

export function useApp(): AppState {
  const state = useContext(AppContext);
  if (!state) throw new Error('useApp must be used inside AppProvider');
  return state;
}

export function useMembers(): Member[] {
  return useApp().group.members;
}
