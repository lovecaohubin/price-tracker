import { useState, useMemo, useEffect, useCallback, useRef, Fragment } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts';
import { TradeRecord, TradeRecordField } from '../types';
import { fetchTradeRecords, saveTradeRecords } from '../services/tradeLogApi';
import { downloadTradeCsv } from '../services/tradeExport';
import TradeRecordForm from './TradeRecordForm';
import { buildPositionAdvice, PositionAdvice } from '../services/positionAdvice';
import { buildAdviceInput } from '../services/adviceInput';
import { fetchMarketSnapshot, MarketHistoryPoint } from '../services/market';
import { runAdviceBacktest, BucketStat } from '../services/adviceBacktest';
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

// 建议仓位单元格：区间文本 + 悬浮说明（评分与逐项依据）
// 置信度不足时模型本来就没有表态，这里显示「数据不足」而不是硬凑一个区间
const adviceRangeText = (adv?: PositionAdvice) => {
  if (!adv) return '—';
  return adv.adviceAvailable
    ? `${Math.round(adv.minPosition * 100)}~${Math.round(adv.maxPosition * 100)}%`
    : '数据不足';
};

// 单元格配色：未给出建议时用中性灰，避免"没结论"被涂成激进/防守色
const adviceCellClass = (adv?: PositionAdvice) => {
  if (!adv) return '';
  return adv.adviceAvailable ? `advice-${adv.level}` : 'advice-insufficient';
};

const adviceTip = (adv?: PositionAdvice) => {
  if (!adv) return '数据不足，无法给出建议';
  const conf = `置信度${adv.confidenceLabel}（因子覆盖 ${Math.round(adv.coverage * 100)}%）`;
  if (!adv.adviceAvailable) return `${conf}\n${adv.action}`;
  return `${adv.levelLabel} · ${adv.score} 分 · ${conf}\n${adv.action}\n${adv.reasons
    .map(r => `${r.delta > 0 ? '+' : ''}${r.delta} ${r.text}`)
    .join('\n')}`;
};

// 回测结果表格：核心指标是「跌超 1%」概率——评分越低该概率越高，说明模型能识别尾部风险
const BucketTable = ({ list, showPosition = false }: { list: BucketStat[]; showPosition?: boolean }) => (
  <table className="bt-table">
    <thead>
      <tr>
        <th>分组</th>
        {showPosition && <th>建议仓位</th>}
        <th>样本</th>
        <th title="次日上证指数涨跌的平均值">平均次日</th>
        <th title="次日上证指数上涨的概率">上涨概率</th>
        <th title="次日跌超 1% 的概率，仓位管理要规避的尾部风险">跌超1%</th>
        <th title="其后 3 个交易日的累计涨跌">平均3日</th>
      </tr>
    </thead>
    <tbody>
      {list.map(b => (
        <tr key={b.label}>
          <td>{b.label}</td>
          {showPosition && <td>{b.positionMid != null ? `${Math.round(b.positionMid * 100)}%` : '—'}</td>}
          <td>{b.samples}</td>
          <td className={pnlClass(b.avgNext1)}>{fmtPctSigned(b.avgNext1)}</td>
          <td>{fmtPct(b.upRate, 1)}</td>
          <td className={b.dangerRate >= 0.12 ? 'down' : ''}>{fmtPct(b.dangerRate, 1)}</td>
          <td className={pnlClass(b.avgNext3)}>{fmtPctSigned(b.avgNext3)}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

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
  // 图表容器尺寸：自维护 ResizeObserver，避免 Recharts ResponsiveContainer 在
  // 组件卸载/重挂载时对已卸载 DOM 调用 getBoundingClientRect 抛空指针
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const [chartSize, setChartSize] = useState({ width: 0, height: 280 });

  useEffect(() => {
    const el = chartWrapRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setChartSize({ width: rect.width, height: rect.height });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
  // 上证指数历史走势：既用于建议模型的均线因子，也用于模型验证回测
  const [history, setHistory] = useState<MarketHistoryPoint[]>([]);
  const [marketError, setMarketError] = useState('');
  const [marketLoading, setMarketLoading] = useState(false);
  // 行情降级状态：接口失败时用的是本地缓存，必须让用户知道这不是实时数据
  const [marketDegraded, setMarketDegraded] = useState<string>('');

  const loadMarket = useCallback(async () => {
    setMarketLoading(true);
    try {
      const snap = await fetchMarketSnapshot(700);
      setHistory(snap.history);
      setMarketError('');
      setMarketDegraded(snap.stale ? snap.note ?? '行情接口不可用，使用的是本地缓存数据' : '');
    } catch (e) {
      setMarketError(e instanceof Error ? e.message : '大盘行情获取失败');
    } finally {
      setMarketLoading(false);
    }
  }, []);

  useEffect(() => { loadMarket(); }, [loadMarket]);

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
    // 最大盈利：历史累计盈亏的最高值，并记录同一条记录的盈利率
    let maxProfit: number | null = null;
    let maxProfitRate: number | null = null;
    for (const r of valid) {
      const v = r.currentAmount as number;
      if (v > runningPeak) runningPeak = v;
      if (runningPeak > 0) maxDrawdown = Math.max(maxDrawdown, (runningPeak - v) / runningPeak);
      if (peak == null || v > peak) peak = v;
      if (r.cumPnl != null && (maxProfit == null || r.cumPnl > maxProfit)) {
        maxProfit = r.cumPnl;
        maxProfitRate = r.cumPnlRate ?? (r.totalAmount ? r.cumPnl / r.totalAmount : null);
      }
    }

    return {
      count: records.length,
      validCount: valid.length,
      invested,
      current: latest?.currentAmount ?? null,
      cumPnl: latest?.cumPnl ?? null,
      cumPnlRate: latest?.cumPnlRate ?? null,
      peak,
      maxProfit,
      maxProfitRate,
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

  // 上证指数标色：相对上一条记录，上涨且突破整百/整千关口 → 红；下跌且跌破整百/整千关口 → 绿
  const sseBreaks = useMemo(() => {
    const map = new Map<string, 'up' | 'down'>();
    let prev: number | null = null;
    for (const r of records) {
      const cur = r.sseIndex;
      if (cur == null) continue;
      if (prev != null && cur !== prev) {
        const hundredLevel = Math.floor(cur / 100) - Math.floor(prev / 100);
        const thousandLevel = Math.floor(cur / 1000) - Math.floor(prev / 1000);
        if (cur > prev && (hundredLevel > 0 || thousandLevel > 0)) map.set(r.id, 'up');
        else if (cur < prev && (hundredLevel < 0 || thousandLevel < 0)) map.set(r.id, 'down');
      }
      prev = cur;
    }
    return map;
  }, [records]);

  // 每条记录对应的「次日仓位建议」：与回测、录入表单共用 buildAdviceInput 的同一套口径
  const adviceMap = useMemo(() => {
    const map = new Map<string, PositionAdvice>();
    records.forEach((r, i) => {
      map.set(r.id, buildPositionAdvice(buildAdviceInput(records, i, history)));
    });
    return map;
  }, [records, history]);

  // 模型验证：用上证指数真实走势检验建议究竟提供了什么信息
  const backtest = useMemo(
    () => (history.length >= 20 ? runAdviceBacktest(records, history) : null),
    [records, history],
  );

  // 方向预测力的上限：取各因子次日相关系数的最大绝对值，用于结论描述
  const maxAbsCorr = useMemo(
    () => (backtest ? Math.max(0, ...backtest.correlations.map(c => Math.abs(c.n1 ?? 0))) : 0),
    [backtest],
  );

  const totalPages = Math.max(1, Math.ceil(listDesc.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageList = listDesc.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  useEffect(() => { setPage(1); }, [keyword]);

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
          <span className="metric-label">最大盈利</span>
          <span className={`metric-value ${pnlClass(stats.maxProfit)}`}>
            {fmtSigned(stats.maxProfit)}
            {stats.maxProfitRate != null && (
              <em className="metric-rate">{fmtPctSigned(stats.maxProfitRate)}</em>
            )}
          </span>
          <span className="metric-foot">累计盈亏最高值</span>
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
          <div className="chart-container" ref={chartWrapRef}>
            {chartSize.width > 0 && (
              <LineChart
                data={chartData}
                width={chartSize.width}
                height={chartSize.height}
                margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
              >
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
                  // 关闭动画：Tooltip 动画期间会访问尚未挂载的容器 DOM，导致 getBoundingClientRect 空指针
                  isAnimationActive={false}
                  wrapperStyle={{ outline: 'none' }}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="#6366f1"
                  strokeWidth={2}
                  dot={false}
                  name={metricMeta.label}
                  isAnimationActive={false}
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
            )}
          </div>
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
                <th title="按当日大盘、主力资金、量价配合与账户状态推导的次日目标仓位区间（悬浮查看评分依据）">建议仓位</th>
                <th>成交量</th>
                <th>涨幅</th>
                <th>主力资金</th>
                <th title="较上一条记录上涨并突破整百/整千关口显示红色，下跌并跌破整百/整千关口显示绿色">上证指数</th>
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
                    <td
                      className={`col-advice ${adviceCellClass(adviceMap.get(r.id))}`}
                      title={adviceTip(adviceMap.get(r.id))}
                    >
                      {adviceRangeText(adviceMap.get(r.id))}
                    </td>
                    <td>{fmtMoney(r.turnover)}</td>
                    <td className={pnlClass(r.changePct)}>{fmtPctSigned(r.changePct)}</td>
                    <td className={pnlClass(r.mainCapital)}>{fmtSigned(r.mainCapital)}</td>
                    <td className={sseBreaks.get(r.id) ?? ''}>
                      {r.sseIndex == null ? '—' : r.sseIndex.toFixed(2)}
                    </td>
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
                      <td colSpan={12}>
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
                  <td colSpan={12} className="table-empty">没有匹配的记录</td>
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

      <div className="backtest-section">
        <div className="backtest-head">
          <h2>模型验证 · 次日仓位建议</h2>
          <span className="backtest-sub">
            {backtest
              ? `用 ${backtest.samples} 条记录（${backtest.from} ~ ${backtest.to}）与上证指数真实走势回测${
                  backtest.suppressed ? `，另有 ${backtest.suppressed} 条因置信度不足未给出建议、未计入` : ''
                }`
              : marketLoading
                ? '正在获取大盘行情…'
                : '大盘行情不可用，回测暂不可用'}
          </span>
        </div>

        {marketDegraded && (
          <div className="market-degraded">
            <span>{marketDegraded}</span>
            <button onClick={loadMarket}>刷新</button>
          </div>
        )}

        {marketError && (
          <div className="analysis-error">
            <span>{marketError}</span>
            <button onClick={loadMarket}>重试</button>
          </div>
        )}

        {backtest && (
          <>
            <p className="backtest-note">
              相关性检验：评分与「次日涨跌方向」的相关系数最高仅
              <b> {maxAbsCorr.toFixed(2)} </b>
              （一般需 &gt;0.3 才有参考价值），所以<b>这个模型不能预测明天涨跌</b>；
              稳定成立的是风险信号——评分越低，次日「跌超 1%」的概率越高（最低分位{' '}
              {fmtPct(backtest.quintiles[0]?.dangerRate ?? 0, 1)} vs 最高分位{' '}
              {fmtPct(backtest.quintiles[backtest.quintiles.length - 1]?.dangerRate ?? 0, 1)}）。
              它的用途是<b>约束风险敞口</b>：让仓位随市场与账户状态自动收缩，而不是代替判断方向。
              另外，因子覆盖不足时模型会选择<b>不出建议</b>——采样区间里有
              <b> {backtest.suppressed} </b>条属于这种情况。
            </p>

            <div className="backtest-grid">
              <div className="backtest-card">
                <h3>各档位（含账户盈亏与杠杆因子）</h3>
                <BucketTable list={backtest.levels} showPosition />
              </div>
              <div className="backtest-card">
                <h3>评分五分位</h3>
                <BucketTable list={backtest.quintiles} />
              </div>
              <div className="backtest-card">
                <h3>均值因子 · 量能 / 近 5 日均量</h3>
                <BucketTable list={backtest.volume} />
              </div>
              <div className="backtest-card">
                <h3>均值因子 · 主力资金偏离 5 日均值</h3>
                <BucketTable list={backtest.capital} />
              </div>
            </div>

            <div className="backtest-corr">
              <span className="corr-title">与前瞻涨跌的相关系数（皮尔逊）</span>
              {backtest.correlations.map(c => (
                <span className="corr-item" key={c.label}>
                  <em>{c.label}</em>
                  <b>1日 {c.n1 == null ? '—' : c.n1.toFixed(3)}</b>
                  <b>3日 {c.n3 == null ? '—' : c.n3.toFixed(3)}</b>
                  <b>5日 {c.n5 == null ? '—' : c.n5.toFixed(3)}</b>
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {formOpen && (
        <TradeRecordForm
          initial={editing}
          existingDates={records.filter(r => r.id !== editing?.id).map(r => r.date)}
          records={records}
          saving={saving}
          onCancel={() => { setFormOpen(false); setEditing(null); }}
          onSubmit={handleSubmit}
        />
      )}
    </div>
  );
}

export default TradeAnalysis;
