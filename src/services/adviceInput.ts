// 由交易记录序列构造「次日仓位建议」的模型输入。
// 表格逐行计算、回测统计、录入表单三处共用同一套口径，避免三处各算一套导致不一致。

import { TradeRecord } from '../types';
import { MarketHistoryPoint } from './market';
import { AdviceInput, meanOf, MEAN_WINDOW } from './positionAdvice';

/** 当日及之前 n 根 K 线的收盘均值（样本不足 5 根视为不可用，避免用极少样本算出的均线误判） */
export function movingAverage(history: MarketHistoryPoint[], i: number, n: number): number | null {
  if (i < 0 || i >= history.length) return null;
  const closes = history.slice(Math.max(0, i - n + 1), i + 1).map((h) => h.close);
  if (closes.length < 5) return null;
  return closes.reduce((a, b) => a + b, 0) / closes.length;
}

/** 收盘价在当日最高/最低之间的位置：越接近 1 说明尾盘越强 */
export function closePositionOf(history: MarketHistoryPoint[], i: number): number | null {
  const h = history[i];
  if (!h || !(h.high > h.low)) return null;
  return (h.close - h.low) / (h.high - h.low);
}

export function historyIndexOf(history: MarketHistoryPoint[] | undefined, date: string): number {
  if (!history) return -1;
  return history.findIndex((h) => h.date === date);
}

/**
 * 构造第 index 条记录的模型输入。
 * 均值口径：成交量均值 / 主力资金均值均取「该记录之前」的最近 N 个交易日（不含当日），
 * 这样「当日 vs 均值」才反映的是相对近期水平的偏离。
 */
export function buildAdviceInput(
  records: TradeRecord[],
  index: number,
  history?: MarketHistoryPoint[],
): AdviceInput {
  const r = records[index];
  const before = records.slice(Math.max(0, index - MEAN_WINDOW), index);
  const turnoverMean = meanOf(before.map((x) => x.turnover));
  const capitalMean = meanOf(before.map((x) => x.mainCapital));

  let prevSse: number | null = null;
  for (let k = index - 1; k >= 0; k--) {
    if (records[k].sseIndex != null) {
      prevSse = records[k].sseIndex;
      break;
    }
  }

  const hIdx = historyIndexOf(history, r.date);
  const his = history ?? [];

  return {
    sseIndex: r.sseIndex,
    prevSseIndex: prevSse,
    mainCapital: r.mainCapital,
    outflowRatio: r.outflowRatio,
    changePct: r.changePct,
    dayPnl: r.dayPnl,
    cumPnlRate: r.cumPnlRate,
    positionRate: r.positionRate,
    principal: r.principal,
    leverage: r.leverage,
    turnover: r.turnover,
    turnoverAvg: turnoverMean.avg,
    mainCapitalAvg: capitalMean.avg,
    avgSample: turnoverMean.sample,
    sseMa5: hIdx >= 0 ? movingAverage(his, hIdx, 5) : null,
    sseMa20: hIdx >= 0 ? movingAverage(his, hIdx, 20) : null,
    sseClosePosition: hIdx >= 0 ? closePositionOf(his, hIdx) : null,
  };
}
