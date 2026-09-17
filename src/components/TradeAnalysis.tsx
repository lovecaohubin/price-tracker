import { useState, useMemo, useEffect, useCallback, Fragment } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { TradeRecord, TradeRecordField } from '../types';
import { fetchTradeRecords, saveTradeRecords } from '../services/tradeLogApi';
import { downloadTradeCsv } from '../services/tradeExport';
import TradeRecordForm from './TradeRecordForm';
import './TradeAnalysis.css';

type RangeKey = '30' | '90' | '365' | 'all';

const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: '30', label: '近30天' },
  { key: '90', label: '近90天' },
  { key: '365', label: '近1年' },
  { key: 'all', label: '全部' },
];

const METRIC_OPTIONS: { key: TradeRecordField; label: string; pct?: boolean }[] = [
  { key: 'currentAmount', label: '当前金额' },
  { key: 'cumPnl', label: '累计盈亏' },
  { key: 'cumPnlRate', label: '累计盈亏比', pct: true },
  { key: 'positionRate', label: '仓位', pct: true },
  { key: 'turnover', label: '成交量' },
  { key: 'mainCapital', label: '主力资金' },
];

const PAGE_SIZE = 20;

const fmtMoney = (v: number | null | undefined) =>
  v == null ? '—' : v.toLocaleString('zh-CN', { maximumFractionDigits: 0 });

const fmtSigned = (v: number | null | undefined) =>
  v == null ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;

const fmtPct = (v: number | null | undefined, digits = 2) =>
  v == null ? '—' : `${(v * 100).toFixed(digits)}%`;

// 图表数值统一格式化：百分比指标带 %，金额按需带单位
const fmtMetricValue = (v: number, isPct: boolean, digits = 2) =>
  isPct
    ? `${(v * 100).toFixed(digits)}%`
    : Math.abs(v) >= 10000
      ? `${(v / 10000).toFixed(2)}万`
      : v.toLocaleString('zh-CN', { maximumFractionDigits: digits });

const fmtPctSigned = (v: number | null | undefined, digits = 2) =>
  v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`;

const pnlClass = (v: number | null | undefined) =>
  v == null || v === 0 ? '' : v > 0 ? 'up' : 'down';

const toDateStr = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 保存前统一按日期重排序号，保证序号连续
function normalize(list: TradeRecord[]): TradeRecord[] {
  return list
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r, i) => ({ ...r, seq: i + 1 }));
}

function TradeAnalysis() {
  const [records, setRecords] = useState<TradeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [range, setRange] = useState<RangeKey>('90');
  const [metric, setMetric] = useState<TradeRecordField>('currentAmount');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TradeRecord | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRecords(normalize(await fetchTradeRecords()));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 提交：先乐观更新界面，落盘失败则回滚
  const commit = useCallback(async (next: TradeRecord[]) => {
    const prev = records;
    setRecords(next);
    setSaving(true);
    try {
      await saveTradeRecords(next);
      setError('');
    } catch (e) {
      setRecords(prev);
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [records]);

  const handleSubmit = (record: TradeRecord) => {
    const next = editing
      ? records.map(r => (r.id === record.id ? record : r))
      : [...records, { ...record, id: `t${Date.now()}` }];
    setFormOpen(false);
    setEditing(null);
    commit(normalize(next));
  };

  const handleDelete = (rec: TradeRecord) => {
    if (!window.confirm(`确认删除 ${rec.date} 的记录？`)) return;
    commit(normalize(records.filter(r => r.id !== rec.id)));
  };

  // 概览指标
  const stats = useMemo(() => {
    const valid = records.filter(r => r.currentAmount != null);
    const latest = valid[valid.length - 1];
    const first = valid[0];

    let invested: number | null = null;
    if (latest) {
      const own = (latest.principal ?? 0) + (latest.leverage ?? 0);
      invested = own > 0 ? own : latest.totalAmount;
    }

    let peak: number | null = null;
    let runningPeak = -Infinity;
    let maxDrawdown = 0;
    for (const r of valid) {
      const v = r.currentAmount as number;
      if (v > runningPeak) runningPeak = v;
      if (runningPeak > 0) maxDrawdown = Math.max(maxDrawdown, (runningPeak - v) / runningPeak);
      if (peak == null || v > peak) peak = v;
    }

    return {
      count: records.length,
      validCount: valid.length,
      invested,
      current: latest?.currentAmount ?? null,
      cumPnl: latest?.cumPnl ?? null,
      cumPnlRate: latest?.cumPnlRate ?? null,
      peak,
      maxDrawdown,
      firstDate: first?.date ?? '',
      latestDate: latest?.date ?? '',
    };
  }, [records]);

  // 图表数据：按时间范围截取，仅保留所选指标有值的点
  const chartData = useMemo(() => {
    let list = records;
    if (range !== 'all') {
      const lastDate = records[records.length - 1]?.date;
      if (lastDate) {
        const cutoff = new Date(`${lastDate}T00:00:00`);
        cutoff.setDate(cutoff.getDate() - Number(range));
        const cutStr = toDateStr(cutoff);
        list = records.filter(r => r.date >= cutStr);
      }
    }
    return list
      .filter(r => r[metric] != null)
      .map(r => ({ date: r.date, value: r[metric] as number }));
  }, [records, range, metric]);

  const metricMeta = METRIC_OPTIONS.find(m => m.key === metric)!;

  // 平均值线：当前区间内该指标所有有效数据点的算术平均
  const avgValue = useMemo(() => {
    if (chartData.length === 0) return null;
    const sum = chartData.reduce((s, p) => s + p.value, 0);
    return sum / chartData.length;
  }, [chartData]);

  // 表格：倒序 + 关键字过滤 + 分页
  const listDesc = useMemo(() => {
    const kw = keyword.trim();
    const matched = kw
      ? records.filter(r => r.date.includes(kw) || r.plan.includes(kw) || r.review.includes(kw))
      : records;
    return matched.slice().reverse();
  }, [records, keyword]);

  const totalPages = Math.max(1, Math.ceil(listDesc.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageList = listDesc.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  useEffect(() => { setPage(1); }, [keyword]);

  // 录入表单用于自动推算派生字段的「上一日」基准：当前金额、总金额、成交量
  const prevSnapshot = useMemo(() => {
    if (!formOpen) {
      return { prevCurrentAmount: null, prevTotalAmount: null, prevTurnover: null };
    }
    const baseDate = editing?.date ?? '9999-12-31';
    const before = records.filter(r => r.date < baseDate);
    const last = before[before.length - 1];
    return {
      prevCurrentAmount: last?.currentAmount ?? null,
      prevTotalAmount: last?.totalAmount ?? null,
      prevTurnover: last?.turnover ?? null,
    };
  }, [formOpen, editing, records]);

  // 导出当前筛选结果（未筛选即全部），按日期升序输出
  const handleExport = () => {
    const list = listDesc.slice().reverse();
    if (list.length === 0) {
      window.alert('当前没有可导出的记录');
      return;
    }
    const tag = keyword.trim() ? '_筛选' : '';
    downloadTradeCsv(list, `交易记录_${toDateStr(new Date())}${tag}.csv`);
  };

  if (loading) {
    return (
      <div className="loading-state">
        <div className="spinner" />
        <p>正在加载交易记录…</p>
      </div>
    );
  }

  return (
    <div className="analysis">
      <div className="analysis-head">
        <div>
          <h2>数据分析 · 交易风控记录</h2>
          <p className="analysis-sub">
            原桌面 XLS 数据已一次性导入，此后直接在页面录入维护
            {stats.firstDate && ` · 覆盖 ${stats.firstDate} ~ ${stats.latestDate}`}
          </p>
        </div>
        <div className="analysis-head-actions">
          {saving && <span className="saving-tip">保存中…</span>}
          <button
            className="btn-export"
            onClick={handleExport}
            title="导出 CSV 文件（Excel 可直接打开）"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            导出数据
          </button>
          <button
            className="btn-add"
            onClick={() => { setEditing(null); setFormOpen(true); }}
          >
            + 录入记录
          </button>
        </div>
      </div>

      {error && (
        <div className="analysis-error">
          <span>{error}</span>
          <button onClick={load}>重新加载</button>
        </div>
      )}

      <div className="metric-cards">
        <div className="metric-card">
          <span className="metric-label">当前金额</span>
          <span className="metric-value">{fmtMoney(stats.current)}</span>
          <span className="metric-foot">{stats.latestDate || '暂无数据'}</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">累计盈亏</span>
          <span className={`metric-value ${pnlClass(stats.cumPnl)}`}>{fmtSigned(stats.cumPnl)}</span>
          <span className={`metric-foot ${pnlClass(stats.cumPnlRate)}`}>{fmtPctSigned(stats.cumPnlRate)}</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">投入本金</span>
          <span className="metric-value">{fmtMoney(stats.invested)}</span>
          <span className="metric-foot">本金 + 杠杆资金</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">峰值金额</span>
          <span className="metric-value">{fmtMoney(stats.peak)}</span>
          <span className="metric-foot">历史最高</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">最大回撤</span>
          <span className="metric-value down">{stats.maxDrawdown > 0 ? `-${(stats.maxDrawdown * 100).toFixed(2)}%` : '—'}</span>
          <span className="metric-foot">峰值回落幅度</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">记录条数</span>
          <span className="metric-value">{stats.count}</span>
          <span className="metric-foot">有效 {stats.validCount} 条</span>
        </div>
      </div>

      <div className="chart-section">
        <div className="chart-header">
          <h2>
            {metricMeta.label}走势
            {avgValue != null && (
              <span className="chart-avg" title="当前区间内该指标所有有效数据点的算术平均值">
                <i className="avg-dash" />
                平均 {fmtMetricValue(avgValue, !!metricMeta.pct)}
                <em>{chartData.length} 个点</em>
              </span>
            )}
          </h2>
          <div className="chart-controls">
            <div className="mini-tabs">
              {METRIC_OPTIONS.map(m => (
                <button
                  key={m.key}
                  className={`mini-tab ${metric === m.key ? 'active' : ''}`}
                  onClick={() => setMetric(m.key)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="mini-tabs">
              {RANGE_OPTIONS.map(r => (
                <button
                  key={r.key}
                  className={`mini-tab ${range === r.key ? 'active' : ''}`}
                  onClick={() => setRange(r.key)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {chartData.length === 0 ? (
          <div className="empty-state">该区间内没有可用于绘图的记录</div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: '#6b7280' }}
                minTickGap={40}
                tickFormatter={(d: string) => d.slice(2)}
              />
              <YAxis
                tick={{ fontSize: 11, fill: '#6b7280' }}
                width={64}
                domain={['auto', 'auto']}
                tickFormatter={(v: number) => {
                  if (metricMeta.pct) return `${(v * 100).toFixed(0)}%`;
                  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(1)}万`;
                  return String(v);
                }}
              />
              <Tooltip
                labelFormatter={(d: string) => `日期 ${d}`}
                formatter={(v: number) => [
                  metricMeta.pct ? fmtPct(v) : v.toLocaleString('zh-CN', { maximumFractionDigits: 2 }),
                  metricMeta.label,
                ]}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="#6366f1"
                strokeWidth={2}
                dot={false}
                name={metricMeta.label}
              />
              {avgValue != null && (
                <ReferenceLine
                  y={avgValue}
                  stroke="#f59e0b"
                  strokeDasharray="6 4"
                  strokeWidth={1.5}
                  label={{
                    value: `平均 ${fmtMetricValue(avgValue, !!metricMeta.pct)}`,
                    position: 'insideTopRight',
                    fill: '#b45309',
                    fontSize: 11,
                  }}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="table-section">
        <div className="table-header">
          <h2>全部记录</h2>
          <div className="table-tools">
            <input
              className="table-search"
              placeholder="搜索日期 / 计划 / 复盘"
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
            />
            <span className="table-count">
              共 {listDesc.length} 条 · 第 {safePage}/{totalPages} 页
            </span>
          </div>
        </div>

        <div className="table-wrap">
          <table className="trade-table">
            <thead>
              <tr>
                <th className="col-date">日期</th>
                <th>当前金额</th>
                <th>当日盈亏</th>
                <th>累计盈亏</th>
                <th>盈亏比</th>
                <th>仓位</th>
                <th>成交量</th>
                <th>涨幅</th>
                <th>主力资金</th>
                <th>上证指数</th>
                <th className="col-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              {pageList.map(r => (
                <Fragment key={r.id}>
                  <tr
                    className={`${r.currentAmount == null ? 'row-empty' : ''} ${expandedId === r.id ? 'row-expanded' : ''}`}
                    onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                  >
                    <td className="col-date">{r.date}</td>
                    <td className={pnlClass(r.dayPnl)}>{fmtMoney(r.currentAmount)}</td>
                    <td className={pnlClass(r.dayPnl)}>{fmtSigned(r.dayPnl)}</td>
                    <td className={pnlClass(r.cumPnl)}>{fmtSigned(r.cumPnl)}</td>
                    <td className={pnlClass(r.cumPnlRate)}>{fmtPctSigned(r.cumPnlRate)}</td>
                    <td>{fmtPct(r.positionRate, 1)}</td>
                    <td>{fmtMoney(r.turnover)}</td>
                    <td className={pnlClass(r.changePct)}>{fmtPctSigned(r.changePct)}</td>
                    <td className={pnlClass(r.mainCapital)}>{fmtSigned(r.mainCapital)}</td>
                    <td>{r.sseIndex == null ? '—' : r.sseIndex.toFixed(2)}</td>
                    <td className="col-ops" onClick={e => e.stopPropagation()}>
                      <button
                        className="btn-row"
                        onClick={() => { setEditing(r); setFormOpen(true); }}
                        title="编辑"
                      >编辑</button>
                      <button
                        className="btn-row danger"
                        onClick={() => handleDelete(r)}
                        title="删除"
                      >删除</button>
                    </td>
                  </tr>
                  {expandedId === r.id && (
                    <tr className="row-detail">
                      <td colSpan={11}>
                        <div className="detail-grid">
                          <div className="detail-item">
                            <span className="detail-label">次日交易计划</span>
                            <p>{r.plan || '—'}</p>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">复盘</span>
                            <p>{r.review || '—'}</p>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">本金 / 杠杆 / 总金额</span>
                            <p>
                              {fmtMoney(r.principal)} / {fmtMoney(r.leverage)} / {fmtMoney(r.totalAmount)}
                            </p>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">市值1 / 市值2</span>
                            <p>
                              {fmtMoney(r.marketValue1)} / {fmtMoney(r.marketValue2)}
                            </p>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">较上一日 / 涨幅 / 主流流出比</span>
                            <p>
                              {fmtSigned(r.vsPrevDay)} / {fmtPctSigned(r.changePct)} / {fmtPctSigned(r.outflowRatio)}
                            </p>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {pageList.length === 0 && (
                <tr>
                  <td colSpan={11} className="table-empty">没有匹配的记录</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="pager">
            <button disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>上一页</button>
            <button disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>下一页</button>
          </div>
        )}
      </div>

      {formOpen && (
        <TradeRecordForm
          initial={editing}
          existingDates={records.filter(r => r.id !== editing?.id).map(r => r.date)}
          prevCurrentAmount={prevSnapshot.prevCurrentAmount}
          prevTotalAmount={prevSnapshot.prevTotalAmount}
          prevTurnover={prevSnapshot.prevTurnover}
          saving={saving}
          onCancel={() => { setFormOpen(false); setEditing(null); }}
          onSubmit={handleSubmit}
        />
      )}
    </div>
  );
}

export default TradeAnalysis;
