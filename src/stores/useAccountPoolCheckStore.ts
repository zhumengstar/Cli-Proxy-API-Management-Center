import { create } from 'zustand';

export type AccountCheckStatus = 'idle' | 'loading' | 'success' | 'error' | 'unsupported';

export type AccountCheckResult = {
  status: AccountCheckStatus;
  message?: string;
};

type AccountCheckSummary = {
  total: number;
  done: number;
  success: number;
  failed: number;
  unsupported: number;
};

interface AccountPoolCheckState {
  activeRunId: string | null;
  checking: boolean;
  results: Record<string, AccountCheckResult>;
  summary: AccountCheckSummary;
  beginCheck: (names: string[]) => string | null;
  setResult: (runId: string, name: string, result: AccountCheckResult) => void;
  finishCheck: (runId: string) => AccountCheckSummary | null;
  pruneResults: (names: string[]) => void;
  clearResults: () => void;
}

const emptySummary = (): AccountCheckSummary => ({
  total: 0,
  done: 0,
  success: 0,
  failed: 0,
  unsupported: 0
});

const createRunId = () => `account-pool-check-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const useAccountPoolCheckStore = create<AccountPoolCheckState>((set, get) => ({
  activeRunId: null,
  checking: false,
  results: {},
  summary: emptySummary(),

  beginCheck: (names) => {
    const uniqueNames = Array.from(new Set(names.filter(Boolean)));
    if (uniqueNames.length === 0 || get().checking) return null;

    const runId = createRunId();
    set((state) => {
      const nextResults = { ...state.results };
      uniqueNames.forEach((name) => {
        nextResults[name] = { status: 'loading' };
      });
      return {
        activeRunId: runId,
        checking: true,
        results: nextResults,
        summary: {
          ...emptySummary(),
          total: uniqueNames.length
        }
      };
    });
    return runId;
  },

  setResult: (runId, name, result) => {
    const state = get();
    if (state.activeRunId !== runId) return;

    set((current) => {
      const previous = current.results[name];
      const nextSummary = { ...current.summary };

      if (previous?.status === 'loading') {
        nextSummary.done += 1;
      }
      if (result.status === 'success') {
        nextSummary.success += 1;
      } else if (result.status === 'unsupported') {
        nextSummary.unsupported += 1;
      } else if (result.status === 'error') {
        nextSummary.failed += 1;
      }

      return {
        results: {
          ...current.results,
          [name]: result
        },
        summary: nextSummary
      };
    });
  },

  finishCheck: (runId) => {
    const state = get();
    if (state.activeRunId !== runId) return null;
    const summary = state.summary;
    set({
      activeRunId: null,
      checking: false,
      summary
    });
    return summary;
  },

  pruneResults: (names) => {
    const allowed = new Set(names);
    set((state) => {
      const next: Record<string, AccountCheckResult> = {};
      Object.entries(state.results).forEach(([name, result]) => {
        if (allowed.has(name)) {
          next[name] = result;
        }
      });
      return { results: next };
    });
  },

  clearResults: () =>
    set({
      activeRunId: null,
      checking: false,
      results: {},
      summary: emptySummary()
    })
}));
