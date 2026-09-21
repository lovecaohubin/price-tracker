// 持有建议模型的样本验证（逐标的、point-in-time）
//
// 与 adviceBacktest.ts 的分工：
//   adviceBacktest.ts 验证的是「账户次日仓位建议」（输入交易记录 + 指数走势）；
//   本文件验证的是「单只标的值不值得继续拿」（输入标的自身的历史日 K）。
//
// 做法：对每只标的取近 300 个交易日的日 K，从第 250 根开始逐日滚动——
//   第 t 天只用「截至第 t 天」的数据构造一个 Asset 快照（当日收盘价、250 日最高价、
//   近 30 日走势、当日涨跌幅与换手率），再交给真正的 buildHoldAdvice 打分，
//   然后看它之后 1 / 3 / 5 个交易日的真实涨跌。全程不使用未来数据。
//
// 三处必须说明的近似（界面上要标注，不能让结论看起来比实际更硬）：
//   1. 历史最高价：日 K 只有 300 根，「距历史最高」用窗口内最高价近似。
//      线上市值用的是 2000 年以来的真实历史最高（周线），但周线含未来信息，回测不能用。
//      因此「距历史最高 >30% 打折」与「创历史新高加分」在回测里只在 300 日窗口内成立。
//   2. 大盘环境：用指数历史按交易日对齐（日期对不上就按「大盘缺失」处理，
//      与线上接口失败时的降级行为一致）。
//   3. 前瞻收益用标的自身的后续真实涨跌，而不是统一指数——问题本身就是
//      「这只标的值不值得继续拿」，用指数涨跌衡量它没有意义。

import { Asset } from '../types';
import { MarketHistoryPoint, MarketSnapshot } from './market';
import { buildHoldAdvice, HoldLevel } from './holdAdvice';
import { fetchKlineRows } from './aStockApi';

/** 东方财富日 K 的 CSV 列序：日期,开,收,高,低,量,额,振幅,涨跌幅,涨跌额,换手率 */
const COL = { DATE: 0, CLOSE: 2, HIGH: 3, LOW: 4, CHANGE_PCT: 8, TURNOVER: 10 };

/** 日 K 只有 300 根，用满 250 根才能算出 52 周新高；向前 5 日用于取前瞻收益 */
const WARMUP = 250;
/** 与线上一致：走势图/均线用近 30 个交易日 */
const HISTORY_WINDOW = 30;
/** 单只标的至少要有多少条「模型真的表态了」的样本才纳入统计 */
const MIN_SAMPLES_PER_ASSET = 10;
/** 汇总样本下限：太少时相关系数与分档统计都没有意义 */
const MIN_SAMPLES_POOLED = 30;

/** 档位展示顺序：从最强到最弱 */
const LEVEL_ORDER: { key: HoldLevel; label: string }[] = [
  { key: 'strong', label: '强势持有' },
  { key: 'hold', label: '持有' },
  { key: 'watch', label: '观望' },
  { key: 'reduce', label: '减仓' },
  { key: 'exit', label: '回避' },
];

/**
 * 日期归一化后做键：指数历史与个股日 K 来自不同接口，
 * 一旦格式有差异（2026-09-18 / 20260918），字符串直接比较会静默对不上，
 * 结果是所有样本都按「大盘缺失」处理，而界面上看不出任何异常。
 */
const dateKey = (date: string): string => date.replace(/\D/g, '').slice(0, 8);

export interface HoldBacktestTarget {
  symbol: string;
  name: string;
  type?: Asset['type'];
}

export interface HoldBucketStat {
  label: string;
  samples: number;
  /** 平均前瞻 1 / 3 / 5 日涨跌 */
  avgNext1: number | null;
  avgNext3: number | null;
  avgNext5: number | null;
  /** 次日上涨概率 */
  upRate: number;
  /** 次日跌超 1% 的概率：持有决策真正要规避的尾部风险 */
  dangerRate: number;
  /** 组内平均评分 */
  avgScore: number | null;
}

export interface HoldCorrelationStat {
  label: string;
  n1: number | null;
  n3: number | null;
  n5: number | null;
  samples: number;
}

export interface HoldAssetBacktest {
  symbol: string;
  name: string;
  /** 参与回测的日 K 根数 */
  bars: number;
  from: string;
  to: string;
  /** 模型给出建议并计入统计的样本数 */
  samples: number;
  /** 因子覆盖不足、模型未表态因而被排除的样本数 */
  suppressed: number;
  /** 该标的整体（不分档）的统计，用来和它的各档位对照 */
  overall: HoldBucketStat;
  buckets: HoldBucketStat[];
}

export interface HoldBacktestResult {
  from: string;
  to: string;
  /** 全部标的的日 K 根数合计 */
  bars: number;
  samples: number;
  suppressed: number;
  buckets: HoldBucketStat[];
  quintiles: HoldBucketStat[];
  correlations: HoldCorrelationStat[];
  /** 评分与前瞻收益是否单调：不成立时档位只能当风险刻度用，不能当方向信号 */
  monotonic: { ok: boolean; detail: string };
  perAsset: HoldAssetBacktest[];
  /** 数据不足被跳过的标的 */
  skipped: { symbol: string; name: string; reason: string }[];
  /**
   * 哪些标的的日 K 取自服务端本地缓存（非交易日 / 接口失败降级），
   * 非空时面板要明示——降级结果与下个工作日的实时回测在最新若干根日 K 上会有差异。
   * 仅 IO 入口会填充；纯计算入口 computeHoldBacktest 不会设置该字段。
   */
  klineStale?: string[];
}

interface Bar {
  date: string;
  close: number;
  high: number;
  low: number;
  changePct: number;
  turnover: number;
}

interface Row {
  date: string;
  score: number;
  level: HoldLevel;
  available: boolean;
  /** 距 52 周新高（正数=还没到新高） */
  gap52Week: number | null;
  /** 现价对 20 日线的乖离 */
  bias20: number | null;
  next1: number | null;
  next3: number | null;
  next5: number | null;
}

function parseBars(rows: string[][]): Bar[] {
  const out: Bar[] = [];
  for (const r of rows) {
    const date = (r[COL.DATE] || '').trim();
    const close = parseFloat(r[COL.CLOSE]);
    if (!date || !(close > 0)) continue;
    const high = parseFloat(r[COL.HIGH]);
    const low = parseFloat(r[COL.LOW]);
    out.push({
      date,
      close,
      high: high > 0 ? high : close,
      low: low > 0 ? low : close,
      changePct: parseFloat(r[COL.CHANGE_PCT]) || 0,
      turnover: parseFloat(r[COL.TURNOVER]) || 0,
    });
  }
  return out;
}

/** 用指数历史构造「第 idx 天收盘时」的大盘快照；均线按当日之前的数据计算，避免未来函数 */
function marketAt(history: MarketHistoryPoint[], idx: number): MarketSnapshot | null {
  if (idx < 20) return null;
  const cur = history[idx];
  const prev = history[idx - 1];
  if (!cur || !prev || !(cur.close > 0) || !(prev.close > 0)) return null;

  const ma = (n: number): number | null => {
    const slice = history.slice(idx - n + 1, idx + 1);
    if (slice.length < n) return null;
    return slice.reduce((sum, h) => sum + h.close, 0) / n;
  };

  return {
    date: cur.date,
    fetchedAt: 0,
    sse: {
      close: cur.close,
      open: cur.open,
      high: cur.high,
      low: cur.low,
      prevClose: prev.close,
      changePct: (cur.close - prev.close) / prev.close,
      amplitude: cur.high > 0 && cur.low > 0 ? (cur.high - cur.low) / prev.close : null,
      closePosition: cur.high > cur.low ? (cur.close - cur.low) / (cur.high - cur.low) : null,
    },
    // 资金流/成交额与持有建议无关，回测里留空，避免伪造当日快照
    szse: { close: null, changePct: null },
    turnover: null,
    turnoverSse: null,
    mainCapital: null,
    mainCapitalSse: null,
    ma5: ma(5),
    ma10: ma(10),
    ma20: ma(20),
    history: [],
    source: 'disk',
    stale: false,
  };
}

const pearson = (xs: number[], ys: number[]): number | null => {
  const n = xs.length;
  if (n < 10) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
};

const mean = (list: number[]): number | null =>
  list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;

function statOf(label: string, rows: Row[]): HoldBucketStat {
  const next1 = rows.map((r) => r.next1).filter((v): v is number => v != null);
  return {
    label,
    samples: rows.length,
    avgNext1: mean(next1),
    avgNext3: mean(rows.map((r) => r.next3).filter((v): v is number => v != null)),
    avgNext5: mean(rows.map((r) => r.next5).filter((v): v is number => v != null)),
    upRate: next1.length ? next1.filter((v) => v > 0).length / next1.length : 0,
    dangerRate: next1.length ? next1.filter((v) => v <= -0.01).length / next1.length : 0,
    avgScore: mean(rows.map((r) => r.score)),
  };
}

function levelBuckets(rows: Row[]): HoldBucketStat[] {
  const out: HoldBucketStat[] = [];
  for (const { key, label } of LEVEL_ORDER) {
    const list = rows.filter((r) => r.level === key);
    if (list.length) out.push(statOf(label, list));
  }
  return out;
}

/** 逐日滚动评估单只标的：每天只用当天及以前的数据打分，再看之后 1/3/5 日的真实涨跌 */
function evaluateAsset(
  target: HoldBacktestTarget,
  bars: Bar[],
  history: MarketHistoryPoint[],
  historyIdx: Map<string, number>,
): Row[] {
  const rows: Row[] = [];
  for (let t = WARMUP; t < bars.length - 1; t++) {
    const priceNow = bars[t].close;
    const window250 = bars.slice(t - WARMUP + 1, t + 1);
    const past = bars.slice(0, t + 1);

    // 历史最高/最低用「窗口内」近似，见文件头说明 1
    const allTimeHigh = Math.max(...past.map((b) => b.high));
    const lows = past.map((b) => b.low).filter((v) => v > 0);

    const asset: Asset = {
      id: target.symbol,
      name: target.name,
      symbol: target.symbol,
      type: target.type ?? 'stock',
      currentPrice: priceNow,
      high52Week: Math.max(...window250.map((b) => b.high)),
      allTimeHigh,
      changePercent: bars[t].changePct,
      priceHistory: bars.slice(t - HISTORY_WINDOW + 1, t + 1).map((b) => ({ date: b.date, price: b.close })),
      turnoverRate: bars[t].turnover,
      lowSince2000: lows.length ? Math.min(...lows) : 0,
    };

    const mi = historyIdx.get(dateKey(bars[t].date));
    const market = mi != null ? marketAt(history, mi) : null;
    const adv = buildHoldAdvice(asset, market);

    const forward = (k: number): number | null => {
      const bar = bars[t + k];
      return bar && bar.close > 0 ? bar.close / priceNow - 1 : null;
    };

    rows.push({
      date: bars[t].date,
      score: adv.score,
      level: adv.level,
      available: adv.adviceAvailable,
      gap52Week: adv.gap52Week,
      bias20: adv.ma20 ? (priceNow - adv.ma20) / adv.ma20 : null,
      next1: forward(1),
      next3: forward(3),
      next5: forward(5),
    });
  }
  return rows;
}

/**
 * 纯计算入口（不碰网络）：传入各标的的原始日 K 行即可，便于离线复算与验证。
 * klines 的 key 为标的代码，value 为原始 CSV 行（拉取失败给 null）。
 */
export function computeHoldBacktest(
  targets: HoldBacktestTarget[],
  klines: Map<string, string[][] | null>,
  history: MarketHistoryPoint[],
): HoldBacktestResult | null {
  if (!targets.length) return null;

  const historyIdx = new Map(history.map((h, i) => [dateKey(h.date), i]));
  const skipped: HoldBacktestResult['skipped'] = [];
  const perAsset: HoldAssetBacktest[] = [];
  const pooled: Row[] = [];
  let barsTotal = 0;

  targets.forEach((target) => {
    const rawRows = klines.get(target.symbol);
    const bars = rawRows ? parseBars(rawRows) : [];
    const minBars = WARMUP + MIN_SAMPLES_PER_ASSET;
    if (bars.length < minBars) {
      skipped.push({
        symbol: target.symbol,
        name: target.name,
        reason: bars.length ? `日 K 仅 ${bars.length} 根，不足 ${minBars} 根` : '日 K 拉取失败',
      });
      return;
    }

    const rows = evaluateAsset(target, bars, history, historyIdx);
    const usable = rows.filter((r) => r.next1 != null);
    // 与 adviceBacktest 一致：模型没表态的交易日不能算进「它的成绩」
    const scored = usable.filter((r) => r.available);
    if (scored.length < MIN_SAMPLES_PER_ASSET) {
      skipped.push({
        symbol: target.symbol,
        name: target.name,
        reason: `有效样本仅 ${scored.length} 条（因子覆盖不足 ${usable.length - scored.length} 条）`,
      });
      return;
    }

    barsTotal += bars.length;
    pooled.push(...scored);
    perAsset.push({
      symbol: target.symbol,
      name: target.name,
      bars: bars.length,
      from: scored[0].date,
      to: scored[scored.length - 1].date,
      samples: scored.length,
      suppressed: usable.length - scored.length,
      overall: statOf('合计', scored),
      buckets: levelBuckets(scored),
    });
  });

  if (pooled.length < MIN_SAMPLES_POOLED) return null;

  const corrOf = (label: string, pick: (r: Row) => number | null): HoldCorrelationStat => {
    const pickK = (k: 'next1' | 'next3' | 'next5') => {
      const pairs = pooled.filter((r) => pick(r) != null && r[k] != null);
      return pearson(pairs.map((r) => pick(r) as number), pairs.map((r) => r[k] as number));
    };
    return {
      label,
      n1: pickK('next1'),
      n3: pickK('next3'),
      n5: pickK('next5'),
      samples: pooled.filter((r) => pick(r) != null && r.next1 != null).length,
    };
  };

  const sorted = [...pooled].sort((a, b) => a.score - b.score);
  const size = Math.floor(sorted.length / 5);
  const quintiles: HoldBucketStat[] = [];
  for (let i = 0; i < 5 && size > 0; i++) {
    const part = sorted.slice(i * size, i === 4 ? sorted.length : (i + 1) * size);
    if (!part.length) continue;
    const low = part[0].score;
    const high = part[part.length - 1].score;
    quintiles.push(statOf(`Q${i + 1}（${low === high ? low : `${low}~${high}`} 分）`, part));
  }

  const q1 = quintiles[0];
  const q5 = quintiles[quintiles.length - 1];
  const fmt = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);
  const ok =
    !!q1 && !!q5 && q1 !== q5 && (q5.avgNext1 ?? 0) > (q1.avgNext1 ?? 0) && q5.dangerRate <= q1.dangerRate;
  const monotonic = {
    ok,
    detail: q1 && q5
      ? `最高分位次日平均 ${fmt(q5.avgNext1)}、跌超 1% 概率 ${fmt(q5.dangerRate)}；` +
        `最低分位次日平均 ${fmt(q1.avgNext1)}、跌超 1% 概率 ${fmt(q1.dangerRate)}`
      : '分位样本不足，无法判断单调性',
  };

  // 各标的的样本区间不一定完全一致（停牌、上市时间），区间取并集的最小/最大值
  const dates = pooled.map((r) => r.date).sort();

  return {
    from: dates[0],
    to: dates[dates.length - 1],
    bars: barsTotal,
    samples: pooled.length,
    suppressed: perAsset.reduce((s, a) => s + a.suppressed, 0),
    buckets: levelBuckets(pooled),
    quintiles,
    correlations: [
      corrOf('综合评分', (r) => r.score),
      corrOf('距 52 周新高（越小越贴近）', (r) => r.gap52Week),
      corrOf('对 20 日线乖离', (r) => r.bias20),
    ],
    monotonic,
    perAsset,
    skipped,
  };
}

/** 带 IO 的入口：并发拉取各标的的日 K（服务端已有缓存），再交给纯计算部分 */
export async function runHoldAdviceBacktest(
  targets: HoldBacktestTarget[],
  history: MarketHistoryPoint[],
): Promise<HoldBacktestResult | null> {
  if (!targets.length) return null;
  const rowList = await Promise.all(targets.map((t) => fetchKlineRows(t.symbol, 'day')));
  const klines = new Map<string, string[][] | null>();
  // 哪几只标的的 K 线来自服务端本地缓存（非交易日 / 接口失败）——必须在 UI 上明示，
  // 否则用户会把降级结果当成实时回测，对照下个工作日跑出来又不一样，难有依据
  const klineStale: string[] = [];
  targets.forEach((t, i) => {
    const r = rowList[i];
    klines.set(t.symbol, r?.rows ?? null);
    if (r?.stale) klineStale.push(t.name || t.symbol);
  });
  const result = computeHoldBacktest(targets, klines, history);
  if (result) result.klineStale = klineStale;
  return result;
}
