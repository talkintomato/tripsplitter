import type { RateSuggester } from '../core/index.js';
import type { AgentModel } from './model.js';
export interface AgentDeps { model: AgentModel; suggestRate: RateSuggester }
export type * from '../tools/types.js';
