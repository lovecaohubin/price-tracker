// 模型有效性回测：用历史记录 + 上证指数真实走势，检验「次日仓位建议」到底提供了什么信息。
//
// 检验分两层：
//  1. 方向预测力：评分与前瞻 1/3/5 日涨跌的相关性（若接近 0，说明它不能预测涨跌方向）；
//  2. 风险识别力：各评分档位对应的「次日跌超 1%」概率（这才是仓位管理关心的指标）。
//
// 同时单独检验 v2 新增的均值因子（量能比、资金偏离均值）是否真的带有信息量。
//
// 只统计「模型真正给出建议」的样本：因子覆盖不足时它明确没有表态，把这些交易日算进成绩里
// 等于替它认领了它没做过的判断。

import { TradeRecord } from '../types';
import { MarketHistoryPoint } from './market';
import { buildAdviceInput } from './adviceInput';
import { buildPositionAdvice, PositionAdvice } from './positionAdvice';

export interface BucketStat {
  label: string;
  samples: number;
  /** 平均前瞻 1 / 3 / 5 日涨跌 */
  avgNext1: number | null;
  avgNext3: number | null;
  avgNext5: number | null;
  /** 次日上涨概率 */
  upRate: number;
  /** 次日跌超 1% 的概率：仓位管理真正要规避的尾部风险 */
  dangerRate: number;
  /** 该分组的建议仓位区间中值（比例类分组为 null） */
  positionMid: number | null;
}

export interface CorrelationStat {
  label: string;
  n1: number | null;
  n3: number | null;
  n5: number | null;
  samples: number;
}

export interface AdviceBacktestResult {
  samples: number;
  from: string;
  to: string;
  /** 因子覆盖不足、模型未出具建议因而被排除的样本数 */
  suppressed: number;
  correlations: CorrelationStat[];
  levels: BucketStat[];
  quintiles: BucketStat[];
  volume: BucketStat[];
  capital: BucketStat[];
}

interface Row {
  date: string;
  score: number;
  marketScore: number | null;
  level: string;
  levelLabel: string;
  minPosition: number;
  maxPosition: number;
  /** 模型是否给出了建议（置信度不足时为 false，不参与统计） */
  available: boolean;
  /** 当日成交量 / 近 5 日均量 */
  volumeRatio: number | null;
  /** 当日主力资金 - 近 5 日均值（亿元） */
  capitalDiff: number | null;
  next1: number | null;
  next3: number | null;
  next5: number | null;
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

function statOf(label: string, rows: Row[]): BucketStat {
  const next1 = rows.map((r) => r.next1).filter((v): v is number => v != null);
  return {
    label,
    samples: rows.length,
    avgNext1: mean(next1),
    avgNext3: mean(rows.map((r) => r.next3).filter((v): v is number => v != null)),
    avgNext5: mean(rows.map((r) => r.next5).filter((v): v is number => v != null)),
    upRate: next1.length ? next1.filter((v) => v > 0).length / next1.length : 0,
    dangerRate: next1.length ? next1.filter((v) => v <= -0.01).length / next1.length : 0,
    // 组内建议仓位区间中值的平均。低置信样本会因向中性收敛而区间不同，所以按行取均值而非取首行
    positionMid: mean(rows.map((r) => (r.minPosition + r.maxPosition) / 2)),
  };
}

const LEVEL_ORDER: { key: string; label: string }[] = [
  { key: 'attack', label: '进攻' },
  { key: 'bullish', label: '偏多' },
  { key: 'neutral', label: '中性' },
  { key: 'bearish', label: '偏空' },
  { key: 'defensive', label: '防守' },
];

export function runAdviceBacktest(
  records: TradeRecord[],
  history: MarketHistoryPoint[],
  days = 1,
): AdviceBacktestResult | null {
  if (records.length < 20 || history.length < 20) return null;

  const idxOf = new Map(history.map((h, i) => [h.date, i]));
  // 记录日收盘 -> k 个交易日后的收盘涨幅（用真实指数走势，而不是下一条记录，避免漏录日期造成偏差）
  const forward = (date: string, k: number): number | null => {
    const i = idxOf.get(date);
    if (i == null || i + k >= history.length) return null;
    return (history[i + k].close - history[i].close) / history[i].close;
  };

  const rows: Row[] = [];
  const adviceByDate = new Map<string, PositionAdvice>();
  records.forEach((r, i) => {
    const input = buildAdviceInput(records, i, history);
    const adv = buildPositionAdvice(input);
    adviceByDate.set(r.date, adv);
    rows.push({
      date: r.date,
      score: adv.score,
      marketScore: adv.marketScore,
      level: adv.level,
      levelLabel: adv.levelLabel,
      minPosition: adv.minPosition,
      maxPosition: adv.maxPosition,
      available: adv.adviceAvailable,
      volumeRatio: r.turnover != null && input.turnoverAvg ? r.turnover / input.turnoverAvg : null,
      capitalDiff:
        r.mainCapital != null && input.mainCapitalAvg != null ? r.mainCapital - input.mainCapitalAvg : null,
      next1: forward(r.date, days),
      next3: forward(r.date, days + 2),
      next5: forward(r.date, days + 4),
    });
  });

  const usable = rows.filter((r) => r.next1 != null);
  // 只统计模型真正给出建议的样本：置信度不足的交易日它没有表态，不该算进"它的成绩"
  const scored = usable.filter((r) => r.available);
  if (scored.length < 20) return null;

  const corrOf = (label: string, pick: (r: Row) => number | null): CorrelationStat => {
    const pick3 = (k: 'next1' | 'next3' | 'next5') => {
      const pairs = scored.filter((r) => pick(r) != null && r[k] != null);
      return pearson(pairs.map((r) => pick(r) as number), pairs.map((r) => r[k] as number));
    };
    const n1Pairs = scored.filter((r) => pick(r) != null && r.next1 != null);
    return { label, n1: pick3('next1'), n3: pick3('next3'), n5: pick3('next5'), samples: n1Pairs.length };
  };

  const levels: BucketStat[] = [];
  for (const { key, label } of LEVEL_ORDER) {
    const list = scored.filter((r) => r.level === key);
    if (!list.length) continue;
    levels.push(statOf(label, list));
  }

  const sorted = [...scored].sort((a, b) => a.score - b.score);
  const size = Math.floor(sorted.length / 5);
  const quintiles: BucketStat[] = [];
  for (let i = 0; i < 5 && size > 0; i++) {
    const part = sorted.slice(i * size, i === 4 ? sorted.length : (i + 1) * size);
    if (!part.length) continue;
    const bound = part.length === 1 ? `${part[0].score}` : `${part[0].score}~${part[part.length - 1].score}`;
    quintiles.push(statOf(`Q${i + 1}（${bound} 分）`, part));
  }

  const volBuckets: { label: string; test: (v: number) => boolean }[] = [
    { label: '缩量 <0.8 倍', test: (v) => v < 0.8 },
    { label: '正常 0.8~1.2 倍', test: (v) => v >= 0.8 && v < 1.2 },
    { label: '放量 1.2~1.5 倍', test: (v) => v >= 1.2 && v < 1.5 },
    { label: '天量 ≥1.5 倍', test: (v) => v >= 1.5 },
  ];
  const volume = volBuckets
    .map(({ label, test }) => ({ label, list: scored.filter((r) => r.volumeRatio != null && test(r.volumeRatio)) }))
    .filter((b) => b.list.length)
    .map((b) => statOf(b.label, b.list));

  const capBuckets: { label: string; test: (v: number) => boolean }[] = [
    { label: '低于均值 300 亿以上', test: (v) => v < -300 },
    { label: '低于均值 0~300 亿', test: (v) => v >= -300 && v < 0 },
    { label: '高于均值 0~300 亿', test: (v) => v >= 0 && v < 300 },
    { label: '高于均值 300 亿以上', test: (v) => v >= 300 },
  ];
  const capital = capBuckets
    .map(({ label, test }) => ({ label, list: scored.filter((r) => r.capitalDiff != null && test(r.capitalDiff)) }))
    .filter((b) => b.list.length)
    .map((b) => statOf(b.label, b.list));

  return {
    samples: scored.length,
    from: scored[0].date,
    to: scored[scored.length - 1].date,
    suppressed: usable.length - scored.length,
    correlations: [
      corrOf('综合评分', (r) => r.score),
      corrOf('市场因子评分', (r) => r.marketScore),
      corrOf('量能 / 近 5 日均量', (r) => r.volumeRatio),
      corrOf('主力资金偏离 5 日均值', (r) => r.capitalDiff),
    ],
    levels,
    quintiles,
    volume,
    capital,
  };
}
