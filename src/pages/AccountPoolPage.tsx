import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { useNotificationStore } from '@/stores';
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
import styles from './AccountPoolPage.module.scss';

type AccountCheckStatus = 'idle' | 'loading' | 'success' | 'error' | 'unsupported';

type AccountCheckResult = {
  status: AccountCheckStatus;
  message?: string;
};

const ACCOUNT_CHECK_CONCURRENCY = 5;
const ACCOUNT_POOL_STORAGE_KEY = 'cli-proxy-account-pool';
const MIN_ACCOUNT_POOL_PAGE_SIZE = 1;
const MAX_ACCOUNT_POOL_PAGE_SIZE = 200;
const DEFAULT_ACCOUNT_POOL_PAGE_SIZE = 24;
const QUOTA_CONFIGS = [
  CLAUDE_CONFIG,
  ANTIGRAVITY_CONFIG,
  CODEX_CONFIG,
  GEMINI_CLI_CONFIG,
  KIMI_CONFIG,
] as Array<QuotaConfig<unknown, unknown>>;

type AccountPoolRecord = {
  file: AuthFileItem;
  content: string;
  hash: string;
  savedAt: number;
};

const isRuntimeOnly = (file: AuthFileItem): boolean => {
  const value = file.runtimeOnly ?? file['runtime_only'];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return false;
};

const getFileType = (file: AuthFileItem): string => String(file.type || file.provider || 'unknown');

const getFileModifiedLabel = (file: AuthFileItem): string => {
  const value = file.modified ?? file['modtime'] ?? file['updated_at'];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return formatUnixTimestamp(value < 1e12 ? value : Math.round(value / 1000));
  }
  if (typeof value === 'string' && value.trim()) return value;
  return '';
};

const buildDownloadFileName = () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `account-pool-${stamp}.zip`;
};

const clampAccountPoolPageSize = (value: number): number =>
  Math.min(MAX_ACCOUNT_POOL_PAGE_SIZE, Math.max(MIN_ACCOUNT_POOL_PAGE_SIZE, Math.round(value)));

const resolveQuotaConfig = (file: AuthFileItem): QuotaConfig<unknown, unknown> | null =>
  QUOTA_CONFIGS.find((config) => config.filterFn(file)) ?? null;

const normalizeJsonForDedupe = (rawText: string): string => {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== 'object') return value;

    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = normalize((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  };

  try {
    return JSON.stringify(normalize(JSON.parse(rawText)));
  } catch {
    return rawText.trim();
  }
};

const hashText = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

const readAccountPoolRecords = (): AccountPoolRecord[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(ACCOUNT_POOL_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.reduce<AccountPoolRecord[]>((records, item) => {
      if (!item || typeof item !== 'object') return records;
      const record = item as Partial<AccountPoolRecord>;
      if (!record.file || typeof record.file !== 'object') return records;
      if (typeof record.content !== 'string' || !record.content.trim()) return records;
      if (typeof record.hash !== 'string' || !record.hash.trim()) return records;
      records.push({
        file: record.file,
        content: record.content,
        hash: record.hash,
        savedAt: typeof record.savedAt === 'number' ? record.savedAt : 0,
      });
      return records;
    }, []);
  } catch {
    return [];
  }
};

const writeAccountPoolRecords = (records: AccountPoolRecord[]) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ACCOUNT_POOL_STORAGE_KEY, JSON.stringify(records));
};

const uniqueAccountPoolRecords = (records: AccountPoolRecord[]): AccountPoolRecord[] => {
  const byHash = new Map<string, AccountPoolRecord>();
  records.forEach((record) => {
    const existing = byHash.get(record.hash);
    if (!existing || record.savedAt > existing.savedAt) {
      byHash.set(record.hash, record);
    }
  });
  return Array.from(byHash.values()).sort((left, right) =>
    left.file.name.localeCompare(right.file.name)
  );
};

const applyAccountPoolRecords = (
  records: AccountPoolRecord[],
  setFiles: (files: AuthFileItem[]) => void,
  setFileContentCache: (cache: Record<string, string>) => void
) => {
  setFiles(records.map((record) => record.file));
  setFileContentCache(
    records.reduce<Record<string, string>>((cache, record) => {
      cache[record.file.name] = record.content;
      return cache;
    }, {})
  );
};

export function AccountPoolPage() {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [fileContentCache, setFileContentCache] = useState<Record<string, string>>({});
  const [checkResults, setCheckResults] = useState<Record<string, AccountCheckResult>>({});
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [downloadingArchive, setDownloadingArchive] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_ACCOUNT_POOL_PAGE_SIZE);
  const [pageSizeInput, setPageSizeInput] = useState(String(DEFAULT_ACCOUNT_POOL_PAGE_SIZE));
  const [selectedNames, setSelectedNames] = useState<string[]>([]);

  const hydrateStoredPool = useCallback(() => {
    const storedRecords = uniqueAccountPoolRecords(readAccountPoolRecords());
    applyAccountPoolRecords(storedRecords, setFiles, setFileContentCache);
    setSelectedNames((current) =>
      current.filter((name) => storedRecords.some((record) => record.file.name === name))
    );
    setCheckResults((current) => {
      const next: Record<string, AccountCheckResult> = {};
      storedRecords.forEach((record) => {
        if (current[record.file.name]) {
          next[record.file.name] = current[record.file.name];
        }
      });
      return next;
    });
    setLoading(false);
    return storedRecords;
  }, []);

  const syncFiles = useCallback(async () => {
    setLoading(true);
    setError('');
    const storedRecords = hydrateStoredPool();
    try {
      const response = await authFilesApi.list();
      const importedFiles = response.files.filter((file) => !isRuntimeOnly(file));
      const nextRecords = [...storedRecords];
      const seenHashes = new Set(storedRecords.map((record) => record.hash));

      await Promise.all(
        importedFiles.map(async (file) => {
          try {
            const rawText = await authFilesApi.downloadText(file.name);
            const hash = await hashText(normalizeJsonForDedupe(rawText));
            if (seenHashes.has(hash)) return;
            seenHashes.add(hash);
            nextRecords.push({
              file,
              content: rawText,
              hash,
              savedAt: Date.now(),
            });
          } catch {
            // Keep the existing pool intact even when a source auth file can no longer be read.
          }
        })
      );

      const mergedRecords = uniqueAccountPoolRecords(nextRecords);
      writeAccountPoolRecords(mergedRecords);
      applyAccountPoolRecords(mergedRecords, setFiles, setFileContentCache);
      setSelectedNames((current) =>
        current.filter((name) => mergedRecords.some((record) => record.file.name === name))
      );
      setCheckResults((current) => {
        const next: Record<string, AccountCheckResult> = {};
        mergedRecords.forEach((record) => {
          if (current[record.file.name]) {
            next[record.file.name] = current[record.file.name];
          }
        });
        return next;
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [hydrateStoredPool, t]);

  useEffect(() => {
    hydrateStoredPool();
  }, [hydrateStoredPool]);

  const typeOptions = useMemo(() => {
    const types = Array.from(new Set(files.map(getFileType))).sort((a, b) => a.localeCompare(b));
    return [
      { value: 'all', label: t('account_pool.type_all') },
      ...types.map((type) => ({ value: type, label: type })),
    ];
  }, [files, t]);

  const filteredFiles = useMemo(() => {
    const term = search.trim().toLowerCase();
    return files.filter((file) => {
      if (typeFilter !== 'all' && getFileType(file) !== typeFilter) return false;
      if (!term) return true;
      return [file.name, getFileType(file), file.statusMessage, file.status]
        .some((value) => String(value ?? '').toLowerCase().includes(term));
    });
  }, [files, search, typeFilter]);

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

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  useEffect(() => {
    setPage(1);
  }, [search, typeFilter]);

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

  const detectAccounts = async (targets: AuthFileItem[]) => {
    if (targets.length === 0 || checking) return;
    setChecking(true);
    let success = 0;
    let failed = 0;
    let unsupported = 0;

    setCheckResults((current) => {
      const next = { ...current };
      targets.forEach((file) => {
        next[file.name] = { status: 'loading' };
      });
      return next;
    });

    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const file = targets[index];
        if (!file) return;

        const config = resolveQuotaConfig(file);
        if (!config) {
          unsupported += 1;
          setCheckResults((current) => ({
            ...current,
            [file.name]: {
              status: 'unsupported',
              message: t('account_pool.check_unsupported'),
            },
          }));
          continue;
        }

        try {
          await config.fetchQuota(file, t);
          success += 1;
          setCheckResults((current) => ({
            ...current,
            [file.name]: {
              status: 'success',
              message: t('account_pool.check_success'),
            },
          }));
        } catch (err: unknown) {
          failed += 1;
          const message = err instanceof Error ? err.message : t('common.unknown_error');
          const status = getStatusFromError(err);
          setCheckResults((current) => ({
            ...current,
            [file.name]: {
              status: 'error',
              message: status ? `${status}: ${message}` : message,
            },
          }));
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(ACCOUNT_CHECK_CONCURRENCY, targets.length) }, () => worker())
      );
      showNotification(
        t('account_pool.check_done', { success, failed, unsupported }),
        failed > 0 ? 'warning' : 'success'
      );
    } finally {
      setChecking(false);
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
