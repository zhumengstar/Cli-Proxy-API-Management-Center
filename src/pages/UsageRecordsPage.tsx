import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  authFilesApi,
  type AccountPoolUsageRecord,
  type AccountPoolUsageSummary,
} from '@/services/api';
import { useNotificationStore } from '@/stores';
import styles from './UsageRecordsPage.module.scss';

const formatUsageRecordTime = (value: string): string => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value || '-';
  return new Date(time).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
};

const formatMetric = (value: number | undefined): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
};

export function UsageRecordsPage() {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [records, setRecords] = useState<AccountPoolUsageRecord[]>([]);
  const [summaries, setSummaries] = useState<AccountPoolUsageSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authFilesApi.getAccountPoolUsageRecords(120);
      setRecords(response.records);
      setSummaries(response.summaries);
    } catch (err: unknown) {
      setRecords([]);
      setSummaries([]);
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      showNotification(message, 'error');
    } finally {
      setLoading(false);
    }
  }, [showNotification, t]);

  const clearRecords = useCallback(async () => {
    try {
      await authFilesApi.clearAccountPoolUsageRecords();
      setRecords([]);
      setSummaries([]);
      showNotification('使用记录已清空', 'success');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      showNotification(`清空使用记录失败：${message}`, 'error');
    }
  }, [showNotification, t]);

  useEffect(() => {
    void loadRecords();
    const timer = window.setInterval(() => {
      void loadRecords();
    }, 8000);
    return () => window.clearInterval(timer);
  }, [loadRecords]);

  const totals = useMemo(
    () =>
      summaries.reduce(
        (acc, item) => {
          acc.requests += item.requests ?? 0;
          acc.successes += item.successes ?? 0;
          acc.failures += item.failures ?? 0;
          acc.tokens += item.total_tokens ?? 0;
          return acc;
        },
        { requests: 0, successes: 0, failures: 0, tokens: 0 }
      ),
    [summaries]
  );

  return (
    <div className={styles.container}>
      <h1 className={styles.pageTitle}>{t('nav.usage_records', { defaultValue: '使用记录' })}</h1>

      <Card>
        <div className={styles.header}>
          <div>
            <h2 className={styles.title}>使用记录</h2>
            <p className={styles.desc}>
              记录外部请求的时间、NewAPI 用户、命中的服务账号邮箱、模型、状态和 Token。
            </p>
          </div>
          <div className={styles.actions}>
            <Button variant="secondary" size="sm" onClick={() => void loadRecords()} loading={loading}>
              {t('common.refresh')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void clearRecords()} disabled={records.length === 0}>
              {t('common.clear', { defaultValue: '清空' })}
            </Button>
          </div>
        </div>

        <div className={styles.stats}>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>请求数</span>
            <strong className={styles.statValue}>{formatMetric(totals.requests)}</strong>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>成功数</span>
            <strong className={styles.statValue}>{formatMetric(totals.successes)}</strong>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>失败数</span>
            <strong className={styles.statValue}>{formatMetric(totals.failures)}</strong>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>总 Token</span>
            <strong className={styles.statValue}>{formatMetric(totals.tokens)}</strong>
          </div>
        </div>

        {records.length === 0 ? (
          <EmptyState
            title={loading ? '正在加载使用记录...' : '暂无使用记录'}
            description="发起一条外部请求后，这里会显示命中的账号邮箱与请求明细。"
          />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>NewAPI 用户</th>
                  <th>服务账号邮箱</th>
                  <th>模型</th>
                  <th>状态</th>
                  <th>Token</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => {
                  const userLabel = record.username || record.newapi_user_id || '-';
                  const statusCode = record.status_code ?? (record.success ? 200 : 0);
                  return (
                    <tr key={record.id}>
                      <td>{formatUsageRecordTime(record.requested_at)}</td>
                      <td>
                        <div className={styles.strong}>{userLabel}</div>
                        {record.newapi_user_id ? <div className={styles.muted}>ID {record.newapi_user_id}</div> : null}
                        {record.session_id ? (
                          <div className={styles.muted} title={record.session_id}>
                            {record.session_id}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <div className={styles.strong}>{record.service_email || record.auth_id || '-'}</div>
                        {record.auth_index ? <div className={styles.muted}>#{record.auth_index}</div> : null}
                      </td>
                      <td>
                        <div className={styles.strong}>{record.alias || record.model || '-'}</div>
                        <div className={styles.muted}>{record.provider || '-'}</div>
                      </td>
                      <td>
                        <span className={record.success ? styles.statusOk : styles.statusError}>
                          {statusCode || (record.success ? 'OK' : 'ERR')}
                        </span>
                        {typeof record.latency_ms === 'number' && record.latency_ms > 0 ? (
                          <div className={styles.muted}>{record.latency_ms} ms</div>
                        ) : null}
                      </td>
                      <td>{record.total_tokens ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
