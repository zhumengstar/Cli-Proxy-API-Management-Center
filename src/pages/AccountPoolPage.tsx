import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { useAccountPoolCheckStore, useNotificationStore } from '@/stores';
import { authFilesApi } from '@/services/api';
import {
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GEMINI_CLI_CONFIG,
  KIMI_CONFIG,
  type QuotaConfig,
} from '@/components/quota';
import type { AuthFileItem } from '@/types/authFile';
import { downloadBlob } from '@/utils/download';
import { formatUnixTimestamp } from '@/utils/format';
import { getStatusFromError } from '@/utils/quota';
import { createZipBlob } from '@/utils/zip';
import {
  ACCOUNT_POOL_UPDATED_EVENT,
  buildAccountPoolFileContentCache,
  readAccountPoolRecords,
  syncAccountPoolFromAuthFiles,
  uniqueAccountPoolRecords,
  type AccountPoolRecord,
} from '@/utils/accountPool';
import styles from './AccountPoolPage.module.scss';

const ACCOUNT_POOL_CHECK_CONCURRENCY_STORAGE_KEY = 'cli-proxy-account-pool-check-concurrency';
const MIN_ACCOUNT_POOL_CHECK_CONCURRENCY = 1;
const MAX_ACCOUNT_POOL_CHECK_CONCURRENCY = 20;
const DEFAULT_ACCOUNT_POOL_CHECK_CONCURRENCY = 5;
const MIN_ACCOUNT_POOL_PAGE_SIZE = 1;
const MAX_ACCOUNT_POOL_PAGE_SIZE = 200;
const DEFAULT_ACCOUNT_POOL_PAGE_SIZE = 24;
const DEFAULT_ACCOUNT_POOL_SORT_MODE = 'check';
const DEFAULT_ACCOUNT_POOL_PLAN_FILTER = 'all';
const QUOTA_CONFIGS = [
  CLAUDE_CONFIG,
  ANTIGRAVITY_CONFIG,
  CODEX_CONFIG,
  GEMINI_CLI_CONFIG,
  KIMI_CONFIG,
] as Array<QuotaConfig<unknown, unknown>>;

const getFileType = (file: AuthFileItem): string => String(file.type || file.provider || 'unknown');

const getFileModifiedLabel = (file: AuthFileItem): string => {
  const value = file.modified ?? file['modtime'] ?? file['updated_at'];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return formatUnixTimestamp(value < 1e12 ? value : Math.round(value / 1000));
  }
  if (typeof value === 'string' && value.trim()) return value;
  return '';
};

const parseDateValue = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const firstDateFromRecords = (records: Array<Record<string, unknown> | null>): number | null => {
  const keys = [
    'registered_at',
    'registeredAt',
    'registration_time',
    'registrationTime',
    'register_time',
    'registerTime',
    'signup_at',
    'signupAt',
    'sign_up_at',
    'signUpAt',
    'created_at',
    'createdAt',
    'account_created_at',
    'accountCreatedAt',
  ];
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = parseDateValue(record[key]);
      if (value !== null) return value;
    }
  }
  return null;
};

const getNestedRecord = (value: unknown, key: string): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object') return null;
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : null;
};

const getRegistrationTime = (
  file: AuthFileItem,
  fileContentCache: Record<string, string>,
  savedAtByName: Map<string, number>
): number | null => {
  const metadata =
    file.metadata && typeof file.metadata === 'object' && !Array.isArray(file.metadata)
      ? (file.metadata as Record<string, unknown>)
      : null;
  const attributes =
    file.attributes && typeof file.attributes === 'object' && !Array.isArray(file.attributes)
      ? (file.attributes as Record<string, unknown>)
      : null;
  const idToken =
    file.id_token && typeof file.id_token === 'object' && !Array.isArray(file.id_token)
      ? (file.id_token as Record<string, unknown>)
      : null;

  let parsedContent: Record<string, unknown> | null = null;
  const rawText = fileContentCache[file.name];
  if (rawText) {
    try {
      const parsed = JSON.parse(rawText) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedContent = parsed as Record<string, unknown>;
      }
    } catch {
      parsedContent = null;
    }
  }

  const detectedTime = firstDateFromRecords([
    file,
    metadata,
    attributes,
    idToken,
    parsedContent,
    getNestedRecord(parsedContent, 'account'),
    getNestedRecord(parsedContent, 'user'),
    getNestedRecord(parsedContent, 'metadata'),
    getNestedRecord(parsedContent, 'profile'),
  ]);
  if (detectedTime !== null) return detectedTime;

  const savedAt = savedAtByName.get(file.name);
  return typeof savedAt === 'number' && Number.isFinite(savedAt) && savedAt > 0 ? savedAt : null;
};

const getPlanValue = (
  file: AuthFileItem,
  fileContentCache: Record<string, string>
): string => {
  const metadata =
    file.metadata && typeof file.metadata === 'object' && !Array.isArray(file.metadata)
      ? (file.metadata as Record<string, unknown>)
      : null;
  const attributes =
    file.attributes && typeof file.attributes === 'object' && !Array.isArray(file.attributes)
      ? (file.attributes as Record<string, unknown>)
      : null;
  const idToken =
    file.id_token && typeof file.id_token === 'object' && !Array.isArray(file.id_token)
      ? (file.id_token as Record<string, unknown>)
      : null;

  let parsedContent: Record<string, unknown> | null = null;
  const rawText = fileContentCache[file.name];
  if (rawText) {
    try {
      const parsed = JSON.parse(rawText) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedContent = parsed as Record<string, unknown>;
      }
    } catch {
      parsedContent = null;
    }
  }

  const keys = ['plan_type', 'planType', 'plan', 'tier', 'account_type', 'accountType'];
  const records = [
    file,
    metadata,
    attributes,
    idToken,
    parsedContent,
    getNestedRecord(parsedContent, 'account'),
    getNestedRecord(parsedContent, 'user'),
    getNestedRecord(parsedContent, 'metadata'),
    getNestedRecord(parsedContent, 'profile'),
  ];
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim().toLowerCase();
      }
    }
  }
  return '';
};

const matchesPlanFilter = (
  file: AuthFileItem,
  fileContentCache: Record<string, string>,
  planFilter: string
): boolean => {
  if (planFilter === DEFAULT_ACCOUNT_POOL_PLAN_FILTER) return true;
  const plan = getPlanValue(file, fileContentCache);
  if (!plan) return false;
  if (planFilter === 'free') return plan.includes('free');
  if (planFilter === 'plus') return plan.includes('plus');
  if (planFilter === 'pro') return plan.includes('pro') || plan.includes('max');
  return true;
};

const getModifiedTime = (file: AuthFileItem): number | null => {
  const candidates = [file.modified, file['modtime'], file['updated_at'], file.updatedAt];
  for (const candidate of candidates) {
    const value = parseDateValue(candidate);
    if (value !== null) return value;
  }
  return null;
};

const buildDownloadFileName = () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `account-pool-${stamp}.zip`;
};

const clampAccountPoolPageSize = (value: number): number =>
  Math.min(MAX_ACCOUNT_POOL_PAGE_SIZE, Math.max(MIN_ACCOUNT_POOL_PAGE_SIZE, Math.round(value)));

const clampAccountPoolCheckConcurrency = (value: number): number =>
  Math.min(
    MAX_ACCOUNT_POOL_CHECK_CONCURRENCY,
    Math.max(MIN_ACCOUNT_POOL_CHECK_CONCURRENCY, Math.round(value))
  );

const readStoredCheckConcurrency = (): number => {
  if (typeof window === 'undefined') return DEFAULT_ACCOUNT_POOL_CHECK_CONCURRENCY;
  const raw = window.localStorage.getItem(ACCOUNT_POOL_CHECK_CONCURRENCY_STORAGE_KEY);
  if (!raw) return DEFAULT_ACCOUNT_POOL_CHECK_CONCURRENCY;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_ACCOUNT_POOL_CHECK_CONCURRENCY;
  return clampAccountPoolCheckConcurrency(parsed);
};

const resolveQuotaConfig = (file: AuthFileItem): QuotaConfig<unknown, unknown> | null =>
  QUOTA_CONFIGS.find((config) => config.filterFn(file)) ?? null;

const getCheckSortRank = (status?: string): number => {
  if (status === 'success') return 0;
  if (status === 'loading') return 1;
  if (status === 'error') return 2;
  if (status === 'unsupported') return 3;
  return 4;
};

const compareOptionalTime = (
  left: number | null,
  right: number | null,
  direction: 'asc' | 'desc'
): number => {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return direction === 'asc' ? left - right : right - left;
};

const applyAccountPoolRecords = (
  records: AccountPoolRecord[],
  setFiles: (files: AuthFileItem[]) => void,
  setFileContentCache: (cache: Record<string, string>) => void,
  setSavedAtByName: (savedAtByName: Map<string, number>) => void
) => {
  setFiles(records.map((record) => record.file));
  setFileContentCache(buildAccountPoolFileContentCache(records));
  setSavedAtByName(new Map(records.map((record) => [record.file.name, record.savedAt])));
};

export function AccountPoolPage() {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const checking = useAccountPoolCheckStore((state) => state.checking);
  const checkResults = useAccountPoolCheckStore((state) => state.results);
  const checkSummary = useAccountPoolCheckStore((state) => state.summary);
  const beginCheck = useAccountPoolCheckStore((state) => state.beginCheck);
  const setCheckResult = useAccountPoolCheckStore((state) => state.setResult);
  const finishCheck = useAccountPoolCheckStore((state) => state.finishCheck);
  const pruneCheckResults = useAccountPoolCheckStore((state) => state.pruneResults);
  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [fileContentCache, setFileContentCache] = useState<Record<string, string>>({});
  const [savedAtByName, setSavedAtByName] = useState<Map<string, number>>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [downloadingArchive, setDownloadingArchive] = useState(false);
  const [overwritingPassed, setOverwritingPassed] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [planFilter, setPlanFilter] = useState(DEFAULT_ACCOUNT_POOL_PLAN_FILTER);
  const [sortMode, setSortMode] = useState(DEFAULT_ACCOUNT_POOL_SORT_MODE);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_ACCOUNT_POOL_PAGE_SIZE);
  const [pageSizeInput, setPageSizeInput] = useState(String(DEFAULT_ACCOUNT_POOL_PAGE_SIZE));
  const [checkConcurrency, setCheckConcurrency] = useState(readStoredCheckConcurrency);
  const [checkConcurrencyInput, setCheckConcurrencyInput] = useState(String(checkConcurrency));
  const [selectedNames, setSelectedNames] = useState<string[]>([]);

  const applyRecords = useCallback((records: AccountPoolRecord[]) => {
    const nextRecords = uniqueAccountPoolRecords(records);
    applyAccountPoolRecords(nextRecords, setFiles, setFileContentCache, setSavedAtByName);
    setSelectedNames((current) =>
      current.filter((name) => nextRecords.some((record) => record.file.name === name))
    );
    pruneCheckResults(nextRecords);
    return nextRecords;
  }, [pruneCheckResults]);

  const hydrateStoredPool = useCallback(() => {
    const storedRecords = applyRecords(readAccountPoolRecords());
    setLoading(false);
    return storedRecords;
  }, [applyRecords]);

  const syncFiles = useCallback(async (showLoading = true) => {
    if (showLoading) {
      setLoading(true);
    }
    setError('');
    hydrateStoredPool();
    try {
      const mergedRecords = await syncAccountPoolFromAuthFiles();
      applyRecords(mergedRecords);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(message);
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [applyRecords, hydrateStoredPool, t]);

  useEffect(() => {
    hydrateStoredPool();
    void syncFiles(false);

    const handleAccountPoolUpdated = (event: Event) => {
      const records = (event as CustomEvent<AccountPoolRecord[]>).detail;
      if (Array.isArray(records)) {
        applyRecords(records);
      }
    };

    window.addEventListener(ACCOUNT_POOL_UPDATED_EVENT, handleAccountPoolUpdated);
    return () => window.removeEventListener(ACCOUNT_POOL_UPDATED_EVENT, handleAccountPoolUpdated);
  }, [applyRecords, hydrateStoredPool, syncFiles]);

  const typeOptions = useMemo(() => {
    const types = Array.from(new Set(files.map(getFileType))).sort((a, b) => a.localeCompare(b));
    return [
      { value: 'all', label: t('account_pool.type_all') },
      ...types.map((type) => ({ value: type, label: type })),
    ];
  }, [files, t]);

  const sortOptions = useMemo(
    () => [
      { value: 'check', label: t('account_pool.sort_check') },
      { value: 'registered_desc', label: t('account_pool.sort_registered_desc') },
      { value: 'registered_asc', label: t('account_pool.sort_registered_asc') },
      { value: 'modified_desc', label: t('account_pool.sort_modified_desc') },
      { value: 'modified_asc', label: t('account_pool.sort_modified_asc') },
    ],
    [t]
  );

  const planOptions = useMemo(
    () => [
      { value: 'all', label: t('account_pool.plan_all') },
      { value: 'free', label: t('account_pool.plan_free') },
      { value: 'plus', label: t('account_pool.plan_plus') },
      { value: 'pro', label: t('account_pool.plan_pro') },
    ],
    [t]
  );

  const filteredFiles = useMemo(() => {
    const term = search.trim().toLowerCase();
    return files
      .filter((file) => {
        if (typeFilter !== 'all' && getFileType(file) !== typeFilter) return false;
        if (!matchesPlanFilter(file, fileContentCache, planFilter)) return false;
        if (!term) return true;
        return [file.name, getFileType(file), file.statusMessage, file.status]
          .some((value) => String(value ?? '').toLowerCase().includes(term));
      })
      .sort((left, right) => {
        if (sortMode === 'registered_desc' || sortMode === 'registered_asc') {
          const timeDiff = compareOptionalTime(
            getRegistrationTime(left, fileContentCache, savedAtByName),
            getRegistrationTime(right, fileContentCache, savedAtByName),
            sortMode === 'registered_asc' ? 'asc' : 'desc'
          );
          if (timeDiff !== 0) return timeDiff;
        } else if (sortMode === 'modified_desc' || sortMode === 'modified_asc') {
          const timeDiff = compareOptionalTime(
            getModifiedTime(left),
            getModifiedTime(right),
            sortMode === 'modified_asc' ? 'asc' : 'desc'
          );
          if (timeDiff !== 0) return timeDiff;
        }

        const rankDiff =
          getCheckSortRank(checkResults[left.name]?.status) -
          getCheckSortRank(checkResults[right.name]?.status);
        if (rankDiff !== 0) return rankDiff;
        return left.name.localeCompare(right.name);
      });
  }, [checkResults, fileContentCache, files, planFilter, savedAtByName, search, sortMode, typeFilter]);

  const selectedSet = useMemo(() => new Set(selectedNames), [selectedNames]);
  const totalPages = Math.max(1, Math.ceil(filteredFiles.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pageItems = filteredFiles.slice(pageStart, pageStart + pageSize);
  const visibleSelectedCount = pageItems.filter((file) => selectedSet.has(file.name)).length;
  const allVisibleSelected = pageItems.length > 0 && visibleSelectedCount === pageItems.length;

  const selectedFiles = useMemo(
    () => files.filter((file) => selectedSet.has(file.name)),
    [files, selectedSet]
  );
  const passedFiles = useMemo(
    () => files.filter((file) => checkResults[file.name]?.status === 'success'),
    [checkResults, files]
  );

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  useEffect(() => {
    setPage(1);
  }, [planFilter, search, sortMode, typeFilter]);

  const commitPageSizeInput = (rawValue: string) => {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      setPageSizeInput(String(pageSize));
      return;
    }

    const value = Number(trimmed);
    if (!Number.isFinite(value)) {
      setPageSizeInput(String(pageSize));
      return;
    }

    const next = clampAccountPoolPageSize(value);
    setPageSize(next);
    setPageSizeInput(String(next));
    setPage(1);
  };

  const handlePageSizeChange = (event: ChangeEvent<HTMLInputElement>) => {
    const rawValue = event.currentTarget.value;
    setPageSizeInput(rawValue);

    const trimmed = rawValue.trim();
    if (!trimmed) return;

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;

    setPageSize(clampAccountPoolPageSize(parsed));
    setPage(1);
  };

  const commitCheckConcurrencyInput = (rawValue: string) => {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      setCheckConcurrencyInput(String(checkConcurrency));
      return;
    }

    const value = Number(trimmed);
    if (!Number.isFinite(value)) {
      setCheckConcurrencyInput(String(checkConcurrency));
      return;
    }

    const next = clampAccountPoolCheckConcurrency(value);
    setCheckConcurrency(next);
    setCheckConcurrencyInput(String(next));
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(ACCOUNT_POOL_CHECK_CONCURRENCY_STORAGE_KEY, String(next));
    }
  };

  const handleCheckConcurrencyChange = (event: ChangeEvent<HTMLInputElement>) => {
    const rawValue = event.currentTarget.value;
    setCheckConcurrencyInput(rawValue);

    const trimmed = rawValue.trim();
    if (!trimmed) return;

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;

    const next = clampAccountPoolCheckConcurrency(parsed);
    setCheckConcurrency(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(ACCOUNT_POOL_CHECK_CONCURRENCY_STORAGE_KEY, String(next));
    }
  };

  const toggleOne = (name: string, checked: boolean) => {
    setSelectedNames((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(name);
      } else {
        next.delete(name);
      }
      return Array.from(next);
    });
  };

  const toggleVisible = (checked: boolean) => {
    setSelectedNames((current) => {
      const next = new Set(current);
      pageItems.forEach((file) => {
        if (checked) {
          next.add(file.name);
        } else {
          next.delete(file.name);
        }
      });
      return Array.from(next);
    });
  };

  const handleDownloadSelected = async () => {
    if (selectedFiles.length === 0) return;
    setDownloading(true);
    try {
      const zipFiles = await Promise.all(
        selectedFiles.map(async (file) => ({
          name: file.name,
          text: fileContentCache[file.name] ?? await authFilesApi.downloadText(file.name),
        }))
      );
      const zipBlob = createZipBlob(zipFiles);
      downloadBlob({ filename: buildDownloadFileName(), blob: zipBlob });
      showNotification(
        t('account_pool.download_success', { count: selectedFiles.length }),
        'success'
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      showNotification(t('account_pool.download_failed', { message }), 'error');
    } finally {
      setDownloading(false);
    }
  };

  const handleDownloadServerArchive = async () => {
    setDownloadingArchive(true);
    try {
      const blob = await authFilesApi.downloadAccountPoolArchive();
      downloadBlob({ filename: buildDownloadFileName(), blob });
      showNotification(t('account_pool.download_archive_success'), 'success');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      showNotification(t('account_pool.download_failed', { message }), 'error');
    } finally {
      setDownloadingArchive(false);
    }
  };

  const overwritePassedAuthFiles = async () => {
    if (passedFiles.length === 0 || overwritingPassed) return;
    const uploadFiles = passedFiles.reduce<File[]>((result, file) => {
      const content = fileContentCache[file.name];
      if (!content) return result;
      result.push(new File([content], file.name, { type: 'application/json' }));
      return result;
    }, []);

    if (uploadFiles.length === 0) {
      showNotification(t('account_pool.overwrite_passed_empty_content'), 'warning');
      return;
    }

    setOverwritingPassed(true);
    try {
      await authFilesApi.deleteAll();
      const result = await authFilesApi.uploadFiles(uploadFiles);
      const skipped = passedFiles.length - uploadFiles.length;
      if (result.failed.length > 0 || skipped > 0) {
        showNotification(
          t('account_pool.overwrite_passed_partial', {
            success: result.uploaded,
            failed: result.failed.length + skipped,
          }),
          'warning'
        );
        return;
      }
      showNotification(
        t('account_pool.overwrite_passed_success', { count: result.uploaded }),
        'success'
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      showNotification(t('account_pool.overwrite_passed_failed', { message }), 'error');
    } finally {
      setOverwritingPassed(false);
    }
  };

  const handleOverwritePassed = () => {
    if (passedFiles.length === 0) return;
    showConfirmation({
      title: t('account_pool.overwrite_passed_title'),
      message: t('account_pool.overwrite_passed_confirm', { count: passedFiles.length }),
      confirmText: t('common.confirm'),
      variant: 'danger',
      onConfirm: overwritePassedAuthFiles,
    });
  };

  const detectAccounts = async (targets: AuthFileItem[]) => {
    if (targets.length === 0 || checking) return;
    const runId = beginCheck(targets.map((file) => file.name));
    if (!runId) return;

    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const file = targets[index];
        if (!file) return;

        const config = resolveQuotaConfig(file);
        if (!config) {
          setCheckResult(runId, file.name, {
            status: 'unsupported',
            message: t('account_pool.check_unsupported'),
          });
          continue;
        }

        try {
          await config.fetchQuota(file, t);
          setCheckResult(runId, file.name, {
            status: 'success',
            message: t('account_pool.check_success'),
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : t('common.unknown_error');
          const status = getStatusFromError(err);
          setCheckResult(runId, file.name, {
            status: 'error',
            message: status ? `${status}: ${message}` : message,
          });
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(checkConcurrency, targets.length) }, () => worker())
      );
      const summary = finishCheck(runId);
      if (!summary) return;
      showNotification(
        t('account_pool.check_done', {
          success: summary.success,
          failed: summary.failed,
          unsupported: summary.unsupported,
        }),
        summary.failed > 0 ? 'warning' : 'success'
      );
    } catch {
      const summary = finishCheck(runId);
      if (summary) {
        showNotification(
          t('account_pool.check_done', {
            success: summary.success,
            failed: summary.failed,
            unsupported: summary.unsupported,
          }),
          summary.failed > 0 ? 'warning' : 'success'
        );
      }
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>{t('account_pool.title')}</h1>
          <p className={styles.description}>{t('account_pool.description')}</p>
        </div>
        <div className={styles.headerActions}>
          <Button variant="secondary" onClick={() => void syncFiles()} loading={loading}>
            {t('account_pool.sync')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void detectAccounts(selectedFiles)}
            loading={checking && selectedFiles.length > 0}
            disabled={checking || selectedFiles.length === 0}
          >
            {t('account_pool.check_selected', { count: selectedFiles.length })}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void detectAccounts(files)}
            loading={checking && selectedFiles.length === 0}
            disabled={checking || files.length === 0}
          >
            {t('account_pool.check_all')}
          </Button>
          <Button
            onClick={handleDownloadSelected}
            loading={downloading}
            disabled={selectedFiles.length === 0 || downloading}
          >
            {t('account_pool.download_selected', { count: selectedFiles.length })}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void handleDownloadServerArchive()}
            loading={downloadingArchive}
            disabled={downloadingArchive}
          >
            {t('account_pool.download_archive')}
          </Button>
          <Button
            variant="danger"
            onClick={handleOverwritePassed}
            loading={overwritingPassed}
            disabled={overwritingPassed || passedFiles.length === 0}
          >
            {t('account_pool.overwrite_passed', { count: passedFiles.length })}
          </Button>
        </div>
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      <Card>
        <div className={styles.toolbar}>
          <div className={styles.filters}>
            <Input
              className={styles.searchInput}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('account_pool.search_placeholder')}
            />
            <Select
              className={styles.typeSelect}
              value={typeFilter}
              options={typeOptions}
              onChange={setTypeFilter}
              ariaLabel={t('account_pool.type_filter')}
            />
            <Select
              className={styles.planSelect}
              value={planFilter}
              options={planOptions}
              onChange={setPlanFilter}
              ariaLabel={t('account_pool.plan_filter')}
            />
            <Select
              className={styles.sortSelect}
              value={sortMode}
              options={sortOptions}
              onChange={setSortMode}
              ariaLabel={t('account_pool.sort_filter')}
            />
            <span className={styles.stats}>
              {t('account_pool.stats', { visible: filteredFiles.length, total: files.length })}
            </span>
            <label className={styles.pageSizeControl}>
              <span>{t('auth_files.page_size_label')}</span>
              <input
                className={styles.pageSizeInput}
                type="number"
                min={MIN_ACCOUNT_POOL_PAGE_SIZE}
                max={MAX_ACCOUNT_POOL_PAGE_SIZE}
                step={1}
                value={pageSizeInput}
                onChange={handlePageSizeChange}
                onBlur={(event) => commitPageSizeInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur();
                  }
                }}
              />
            </label>
            <label className={styles.pageSizeControl}>
              <span>{t('account_pool.check_concurrency')}</span>
              <input
                className={styles.checkConcurrencyInput}
                type="number"
                min={MIN_ACCOUNT_POOL_CHECK_CONCURRENCY}
                max={MAX_ACCOUNT_POOL_CHECK_CONCURRENCY}
                step={1}
                value={checkConcurrencyInput}
                disabled={checking}
                onChange={handleCheckConcurrencyChange}
                onBlur={(event) => commitCheckConcurrencyInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur();
                  }
                }}
              />
            </label>
          </div>
          <div className={styles.selectionActions}>
            <SelectionCheckbox
              checked={allVisibleSelected}
              onChange={toggleVisible}
              disabled={pageItems.length === 0}
              label={t('account_pool.select_visible')}
            />
            <Button variant="ghost" size="sm" onClick={() => setSelectedNames([])}>
              {t('account_pool.clear_selection')}
            </Button>
          </div>
        </div>

        {checking && (
          <div className={styles.checkProgress}>
            {t('account_pool.check_progress', {
              done: checkSummary.done,
              total: checkSummary.total,
              success: checkSummary.success,
              failed: checkSummary.failed,
              unsupported: checkSummary.unsupported,
            })}
          </div>
        )}

        {loading ? (
          <div className={styles.hint}>{t('common.loading')}</div>
        ) : filteredFiles.length === 0 ? (
          <EmptyState
            title={t('account_pool.empty_title')}
            description={t('account_pool.empty_desc')}
          />
        ) : (
          <div className={styles.poolGrid}>
            {pageItems.map((file) => {
              const checked = selectedSet.has(file.name);
              const type = getFileType(file);
              const modifiedLabel = getFileModifiedLabel(file);
              const statusMessage = String(file.statusMessage || file['status_message'] || '');
              const checkResult = checkResults[file.name];
              return (
                <div
                  key={file.name}
                  className={`${styles.poolCard} ${checked ? styles.poolCardSelected : ''}`}
                >
                  <div className={styles.cardTop}>
                    <SelectionCheckbox
                      checked={checked}
                      onChange={(value) => toggleOne(file.name, value)}
                      ariaLabel={file.name}
                    />
                    <div className={styles.cardMain}>
                      <div className={styles.fileName}>{file.name}</div>
                      <div className={styles.metaRow}>
                        <span className={styles.typeBadge}>{type}</span>
                        {modifiedLabel && <span className={styles.muted}>{modifiedLabel}</span>}
                      </div>
                    </div>
                  </div>
                  {checkResult && (
                    <div
                      className={`${styles.checkLine} ${
                        checkResult.status === 'success'
                          ? styles.checkSuccess
                          : checkResult.status === 'loading'
                            ? styles.checkLoading
                            : checkResult.status === 'unsupported'
                              ? styles.checkUnsupported
                              : styles.checkError
                      }`}
                    >
                      {checkResult.status === 'loading'
                        ? t('account_pool.checking')
                        : checkResult.message}
                    </div>
                  )}
                  {statusMessage && <div className={styles.statusLine}>{statusMessage}</div>}
                </div>
              );
            })}
          </div>
        )}

        {!loading && filteredFiles.length > pageSize && (
          <div className={styles.pagination}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1}
            >
              {t('auth_files.pagination_prev')}
            </Button>
            <div className={styles.pageInfo}>
              {t('auth_files.pagination_info', {
                current: currentPage,
                total: totalPages,
                count: filteredFiles.length,
              })}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage >= totalPages}
            >
              {t('auth_files.pagination_next')}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
