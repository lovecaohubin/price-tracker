import { useEffect, useMemo, useRef, useState } from 'react';
import { TradeRecord, TradeRecordField } from '../types';
import { buildPositionAdvice, meanOf, MEAN_WINDOW } from '../services/positionAdvice';
import { closePositionOf, historyIndexOf, movingAverage } from '../services/adviceInput';
import { fetchMarketSnapshot, MarketSnapshot } from '../services/market';
import './TradeRecordForm.css';

interface FieldDef {
  key: TradeRecordField;
  label: string;
  unit: string;
  pct?: boolean;
}

const GROUPS: { title: string; fields: FieldDef[] }[] = [
  {
    title: '资金',
    fields: [
      { key: 'principal', label: '本金', unit: '元' },
      { key: 'leverage', label: '杠杆资金', unit: '元' },
      { key: 'totalAmount', label: '总金额', unit: '元' },
      { key: 'currentAmount', label: '当前金额', unit: '元' },
    ],
  },
  {
    title: '盈亏与仓位',
    fields: [
      { key: 'dayPnl', label: '当日盈亏', unit: '元' },
      { key: 'cumPnl', label: '累计盈亏', unit: '元' },
      { key: 'cumPnlRate', label: '累计盈亏比', unit: '%', pct: true },
      { key: 'positionRate', label: '仓位', unit: '%', pct: true },
    ],
  },
  {
    title: '盘面数据',
    fields: [
      { key: 'marketValue1', label: '市值1', unit: '元' },
      { key: 'marketValue2', label: '市值2', unit: '元' },
      { key: 'turnover', label: '成交量', unit: '' },
      { key: 'vsPrevDay', label: '较上一日', unit: '' },
      { key: 'changePct', label: '涨幅', unit: '%', pct: true },
      { key: 'mainCapital', label: '主力资金', unit: '' },
      { key: 'outflowRatio', label: '主流流出比', unit: '%', pct: true },
      { key: 'sseIndex', label: '上证指数', unit: '' },
    ],
  },
];

const ALL_FIELDS = GROUPS.flatMap(g => g.fields);
const PCT_KEYS = new Set(ALL_FIELDS.filter(f => f.pct).map(f => f.key));

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// 存储值 → 输入框文本（比率类放大为百分数，便于阅读录入）
function toInput(v: number | null | undefined, pct: boolean): string {
  if (v == null) return '';
  const n = pct ? v * 100 : v;
  return String(Math.round(n * 1e6) / 1e6);
}

// 输入框文本 → 存储值（百分数还原为小数）
function parseValue(s: string, pct: boolean): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return pct ? n / 100 : n;
}

// 新建记录时 totalAmount 字段的默认占位值，便于"本金+杠杆=0"的兜底
const DEFAULT_TOTAL_AMOUNT = 555000;

// 自动联动字段的展示说明（表单 helper 文案 + 「自动」徽章的依据）
const AUTO_HELPERS: Partial<Record<TradeRecordField, string>> = {
  dayPnl: '= 当日当前金额 - 昨日当前金额',
  cumPnl: '= 当前金额 - 总金额',
  cumPnlRate: '= 累计盈亏 / 总金额',
  positionRate: '= (市值1 + 市值2) / 当前金额',
  vsPrevDay: '= 当日成交量 - 昨日成交量',
  changePct: '= 较上一日 / 昨日成交量',
  outflowRatio: '= 主力资金 / 当日成交量',
};

interface Props {
  initial: TradeRecord | null;
  existingDates: string[];
  /** 全部记录（升序），用于按录入日期定位上一交易日 */
  records: TradeRecord[];
  saving: boolean;
  onCancel: () => void;
  onSubmit: (record: TradeRecord) => void;
}

function TradeRecordForm({
  initial, existingDates, records,
  saving, onCancel, onSubmit,
}: Props) {
  const [date, setDate] = useState(initial?.date ?? todayStr());
  const [plan, setPlan] = useState(initial?.plan ?? '');
  const [review, setReview] = useState(initial?.review ?? '');

  // 上一交易日记录：随录入日期实时定位，既用于派生字段回算，也作为次日仓位建议的大盘基准
  const prevRecord = useMemo(() => {
    const before = records.filter(r => r.date < date);
    return before[before.length - 1] ?? null;
  }, [records, date]);

  // 上一交易日的基准值，供派生字段（当日盈亏 / 较上一日 / 涨幅）回算
  const prevCurrentAmount = prevRecord?.currentAmount ?? null;
  const prevTotalAmount = prevRecord?.totalAmount ?? null;
  const prevTurnover = prevRecord?.turnover ?? null;
  const [inputs, setInputs] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of ALL_FIELDS) {
      let v = initial?.[f.key] as number | null | undefined;
      // 新建记录时，totalAmount 默认填 555000，便于派生字段立即可用
      if (!initial && f.key === 'totalAmount' && v == null) {
        v = DEFAULT_TOTAL_AMOUNT;
      }
      init[f.key] = toInput(v, !!f.pct);
    }
    return init;
  });
  const [err, setErr] = useState('');
  // 大盘数据（接口）：当日指数、两市成交额与主力净流入，以及模型需要的指数均线
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketNote, setMarketNote] = useState('');
  const [marketErr, setMarketErr] = useState('');

  // 均值基准：取录入日期之前最近 N 个交易日，与当日值同口径比较
  const meanSample = useMemo(
    () => records.filter(r => r.date < date).slice(-MEAN_WINDOW),
    [records, date],
  );
  const turnoverMean = useMemo(() => meanOf(meanSample.map(r => r.turnover)), [meanSample]);
  const capitalMean = useMemo(() => meanOf(meanSample.map(r => r.mainCapital)), [meanSample]);

  // 录入日期对应的指数均线与收盘位置（按日期从历史行情中定位）
  const marketCtx = useMemo(() => {
    if (!market) return { ma5: null as number | null, ma20: null as number | null, closePosition: null as number | null };
    const i = historyIndexOf(market.history, date);
    return {
      ma5: i >= 0 ? movingAverage(market.history, i, 5) : null,
      ma20: i >= 0 ? movingAverage(market.history, i, 20) : null,
      closePosition: i >= 0 ? closePositionOf(market.history, i) : null,
    };
  }, [market, date]);

  // 录入日期改变后，上一交易日基准随之变化，需要重算依赖它的派生字段
  const lastDateRef = useRef(date);
  useEffect(() => {
    if (lastDateRef.current === date) return;
    lastDateRef.current = date;
    setInputs(prev => {
      const next = { ...prev };
      recomputeDerived(next);
      return next;
    });
  }, [date, prevCurrentAmount, prevTotalAmount, prevTurnover]);

  // 次日仓位建议：随输入实时刷新（计算量极小，无需额外缓存）
  const advice = buildPositionAdvice({
    sseIndex: parseValue(inputs.sseIndex ?? '', false),
    prevSseIndex: prevRecord?.sseIndex ?? null,
    mainCapital: parseValue(inputs.mainCapital ?? '', false),
    outflowRatio: parseValue(inputs.outflowRatio ?? '', true),
    changePct: parseValue(inputs.changePct ?? '', true),
    dayPnl: parseValue(inputs.dayPnl ?? '', false),
    cumPnlRate: parseValue(inputs.cumPnlRate ?? '', true),
    positionRate: parseValue(inputs.positionRate ?? '', true),
    principal: parseValue(inputs.principal ?? '', false),
    leverage: parseValue(inputs.leverage ?? '', false),
    turnover: parseValue(inputs.turnover ?? '', false),
    turnoverAvg: turnoverMean.avg,
    mainCapitalAvg: capitalMean.avg,
    avgSample: turnoverMean.sample,
    sseMa5: marketCtx.ma5,
    sseMa20: marketCtx.ma20,
    sseClosePosition: marketCtx.closePosition,
  });

  // 全量重算所有派生字段。每次输入都跑一遍，依赖链简单稳定
  const recomputeDerived = (next: Record<string, string>) => {
    const v1 = parseValue(next.marketValue1 ?? '', false);
    const v2 = parseValue(next.marketValue2 ?? '', false);
    const cur = parseValue(next.currentAmount ?? '', false);
    const tot = parseValue(next.totalAmount ?? '', false);
    const turn = parseValue(next.turnover ?? '', false);

    // 累计盈亏 = 当前金额 - 总金额；累计盈亏比 = 累计盈亏 / 总金额
    if (cur != null && tot != null) {
      const cum = cur - tot;
      next.cumPnl = toInput(cum, false);
      if (tot !== 0) next.cumPnlRate = toInput(cum / tot, true);
    }
    // 仓位 = (市值1 + 市值2) / 当前金额（市值任一非空、当前金额非零才计算）
    const sumMv = (v1 != null || v2 != null) ? ((v1 ?? 0) + (v2 ?? 0)) : null;
    if (sumMv != null && cur != null && cur !== 0) {
      next.positionRate = toInput(sumMv / cur, true);
    }
    // 当日盈亏 = 当日当前金额 - 昨日当前金额（无昨日则保留原值）
    if (cur != null && prevCurrentAmount != null) {
      next.dayPnl = toInput(cur - prevCurrentAmount, false);
    }
    // 较上一日 = 当日成交量 - 昨日成交量（无昨日则保留原值）
    if (turn != null && prevTurnover != null) {
      next.vsPrevDay = toInput(turn - prevTurnover, false);
    }
    // 涨幅 = 较上一日 / 昨日成交量（昨日成交量缺失或为 0 则保留原值）
    const vpd = parseValue(next.vsPrevDay ?? '', false);
    if (vpd != null && prevTurnover != null && prevTurnover !== 0) {
      next.changePct = toInput(vpd / prevTurnover, true);
    }
    // 主流流出比 = 主力资金 / 当日成交量
    const m = parseValue(next.mainCapital ?? '', false);
    if (m != null && turn != null && turn !== 0) {
      next.outflowRatio = toInput(m / turn, true);
    }
  };

  const setField = (key: string, value: string) => {
    setInputs(prev => {
      const next = { ...prev, [key]: value };
      recomputeDerived(next);
      return next;
    });
  };

  // 按已录入的数据推算派生字段，减少手工计算
  const autoFill = () => {
    const next = { ...inputs };
    // 总金额：principal+leverage 之和；若二者皆空且未填，则默认 555000
    if (parseValue(next.totalAmount ?? '', false) == null) {
      const principal = parseValue(inputs.principal ?? '', false);
      const leverage = parseValue(inputs.leverage ?? '', false);
      const sum = (principal ?? 0) + (leverage ?? 0);
      next.totalAmount = toInput(sum > 0 ? sum : DEFAULT_TOTAL_AMOUNT, false);
    }
    recomputeDerived(next);
    setInputs(next);
  };

  // 从接口获取大盘数据：录入当日直接填入「上证指数 / 成交量 / 主力资金」；
  // 补录历史日期时只填上证指数（成交额与主力资金接口仅提供当日值，不可回溯）
  const loadMarket = async () => {
    setMarketLoading(true);
    setMarketErr('');
    setMarketNote('');
    try {
      const snap = await fetchMarketSnapshot(150);
      setMarket(snap);
      const sameDay = snap.date === date;
      const point = snap.history.find(p => p.date === date);
      setInputs(prev => {
        const next = { ...prev };
        if (sameDay) {
          next.sseIndex = toInput(snap.sse.close, false);
          if (snap.turnover != null) next.turnover = toInput(snap.turnover, false);
          if (snap.mainCapital != null) next.mainCapital = toInput(snap.mainCapital, false);
        } else if (point) {
          next.sseIndex = toInput(point.close, false);
        }
        recomputeDerived(next);
        return next;
      });
      if (sameDay) {
        setMarketNote(
          `已填入 ${snap.date} 大盘数据（口径为沪深两市，可与你的数据源核对）${
            snap.source === 'disk' ? '，数据来自本地缓存' : ''
          }`,
        );
      } else if (point) {
        setMarketNote(`${snap.date} 为最新交易日，已按 ${date} 的历史收盘填入上证指数；成交额与主力资金当日值不可回溯，需手工填写`);
      } else {
        setMarketNote(`接口最新交易日为 ${snap.date}，${date} 无行情数据（非交易日？）`);
      }
    } catch (e) {
      setMarketErr(e instanceof Error ? e.message : String(e));
    } finally {
      setMarketLoading(false);
    }
  };

  const submit = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setErr('日期格式应为 YYYY-MM-DD');
      return;
    }
    const d = new Date(`${date}T00:00:00`);
    if (Number.isNaN(d.getTime())) {
      setErr('日期无效');
      return;
    }
    if (existingDates.includes(date)) {
      setErr('该日期已存在记录，请直接编辑那一条');
      return;
    }

    const nums: Partial<Record<TradeRecordField, number | null>> = {};
    for (const f of ALL_FIELDS) {
      nums[f.key] = parseValue(inputs[f.key] ?? '', !!f.pct);
    }

    onSubmit({
      id: initial?.id ?? '',
      seq: initial?.seq ?? 0,
      date,
      plan,
      review,
      ...(nums as Record<TradeRecordField, number | null>),
    } as TradeRecord);
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal trade-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{initial ? `编辑记录 · ${initial.date}` : '录入交易记录'}</h2>
          <button className="btn-close" onClick={onCancel}>✕</button>
        </div>

        <div className="trade-form-body">
          <div className="form-row">
            <label className="form-field">
              <span>日期 <i>*</i></span>
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
              />
            </label>
            <div className="form-hint">
              {prevCurrentAmount != null && <span>昨日当前金额：{prevCurrentAmount.toLocaleString('zh-CN')}</span>}
              {prevTotalAmount != null && <span>昨日总金额：{prevTotalAmount.toLocaleString('zh-CN')}</span>}
              {prevTurnover != null && <span>昨日成交量：{prevTurnover.toLocaleString('zh-CN')}</span>}
              <button className="btn-ghost" onClick={autoFill} type="button">
                自动计算派生字段
              </button>
            </div>
          </div>

          {GROUPS.map(g => (
            <div className="form-group" key={g.title}>
              <h4>{g.title}</h4>
              <div className="form-grid">
                {g.fields.map(f => {
                  const helper = AUTO_HELPERS[f.key];
                  const isAuto = !!helper;
                  return (
                    <label className="form-field" key={f.key}>
                      <span>
                        {f.label}
                        {f.unit && <em>{f.unit}</em>}
                        {isAuto && <em className="auto-tag">自动</em>}
                      </span>
                      <input
                        type="number"
                        step="any"
                        placeholder="—"
                        value={inputs[f.key] ?? ''}
                        onChange={e => setField(f.key, e.target.value)}
                        readOnly={isAuto}
                      />
                      {isAuto && <small className="form-helper">{helper}</small>}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}

          {/* 大盘数据：一键从接口获取，作为模型的大盘与均线输入 */}
          <div className="market-bar">
            <button className="btn-ghost" type="button" onClick={loadMarket} disabled={marketLoading}>
              {marketLoading ? '获取中…' : '获取大盘数据'}
            </button>
            {marketErr && <span className="market-err">{marketErr}</span>}
            {market?.stale && (
              <span className="market-warn">
                {market.note ?? '行情接口不可用，使用的是本地缓存数据'}
              </span>
            )}
            {marketNote && <span className="market-note">{marketNote}</span>}
            {market && (
              <span className="market-facts">
                {market.date} 上证 {market.sse.close.toFixed(2)}
                {market.sse.changePct != null && (
                  <>（{market.sse.changePct > 0 ? '+' : ''}{(market.sse.changePct * 100).toFixed(2)}%）</>
                )}
                {market.turnover != null && <>｜两市成交额 {Math.round(market.turnover).toLocaleString('zh-CN')} 亿</>}
                {market.mainCapital != null && <>｜主力净流入 {Math.round(market.mainCapital).toLocaleString('zh-CN')} 亿</>}
                {market.ma5 != null && <>｜MA5 {market.ma5.toFixed(2)}</>}
                {market.ma20 != null && <>｜MA20 {market.ma20.toFixed(2)}</>}
              </span>
            )}
          </div>

          {/* 次日仓位建议：由大盘、主力资金、量价配合与账户状态实时推导 */}
          <div className={`advice-panel ${advice.adviceAvailable ? `advice-${advice.level}` : 'advice-insufficient'}`}>
            <div className="advice-head">
              <span className="advice-title">次日仓位建议</span>
              {advice.adviceAvailable ? (
                <>
                  <span className="advice-tag">{advice.levelLabel}</span>
                  <span className="advice-score">{advice.score} 分</span>
                </>
              ) : (
                <span className="advice-tag">不给出建议</span>
              )}
              <span
                className={`advice-conf conf-${advice.confidence}`}
                title={`已有因子权重覆盖 ${Math.round(advice.coverage * 100)}%（其中市场侧 ${Math.round(
                  advice.marketCoverage * 100,
                )}%）；覆盖率低于 35% 时模型不出具建议`}
              >
                置信度 {advice.confidenceLabel}
              </span>
              <span className={`advice-range ${advice.adviceAvailable ? '' : 'na'}`}>
                {advice.adviceAvailable
                  ? `${Math.round(advice.minPosition * 100)}% ~ ${Math.round(advice.maxPosition * 100)}%`
                  : '暂不给出'}
              </span>
            </div>
            {advice.adviceAvailable && (
              <div className="advice-bar">
                <i style={{ width: `${advice.score}%` }} />
              </div>
            )}
            <p className="advice-action">{advice.action}</p>
            {advice.adviceAvailable && (
              <ul className="advice-reasons">
                {advice.reasons.map(r => (
                  <li key={r.text} className={r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''}>
                    <b>{r.delta > 0 ? `+${r.delta}` : r.delta}</b>
                    <span>{r.text}</span>
                  </li>
                ))}
              </ul>
            )}
            {advice.adviceAvailable && turnoverMean.avg != null && (
              <p className="advice-mean">
                均值基准（前 {turnoverMean.sample} 个交易日）：成交量均值{' '}
                {Math.round(turnoverMean.avg).toLocaleString('zh-CN')}
                {capitalMean.avg != null && (
                  <>｜主力资金均值 {Math.round(capitalMean.avg).toLocaleString('zh-CN')}</>
                )}
              </p>
            )}
            {(advice.missing.length > 0 || advice.confidence !== 'high') && (
              <p className="advice-missing">
                因子覆盖 {Math.round(advice.coverage * 100)}%
                {advice.missing.length > 0 && <>｜缺少：{advice.missing.join('、')}</>}
                {advice.confidence === 'medium' && '，评分误差偏大，仅作方向参考'}
                {advice.confidence === 'low' && '，方向性判断已折半、区间向中性收敛'}
              </p>
            )}
            <p className="advice-note">
              该区间是「次日风险敞口」建议：低分时收缩仓位以规避大跌（数据分析页有历史回测验证），不是涨跌预测。
            </p>
          </div>

          <div className="form-group">
            <h4>文字记录</h4>
            <label className="form-field block">
              <span>次日交易计划</span>
              <textarea
                rows={2}
                value={plan}
                onChange={e => setPlan(e.target.value)}
                placeholder="明日操作思路…"
              />
            </label>
            <label className="form-field block">
              <span>复盘</span>
              <textarea
                rows={2}
                value={review}
                onChange={e => setReview(e.target.value)}
                placeholder="今日复盘总结…"
              />
            </label>
          </div>

          {err && <div className="form-error">{err}</div>}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onCancel}>取消</button>
          <button className="btn-primary" onClick={submit} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default TradeRecordForm;
