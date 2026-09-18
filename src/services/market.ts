// 大盘数据客户端：服务端已代理腾讯日 K（历史）与东财快照/资金流（当日），
// 这里统一成前端使用的结构，供「次日仓位建议」与回测验证消费。

export interface MarketHistoryPoint {
  date: string;
  close: number;
  open: number;
  high: number;
  low: number;
  changePct: number | null;
  volumeHand: number;
}

export interface MarketSnapshot {
  date: string;
  fetchedAt: number;
  sse: {
    close: number;
    open: number;
    high: number;
    low: number;
    prevClose: number;
    changePct: number | null;
    amplitude: number | null;
    closePosition: number | null;
  };
  szse: { close: number | null; changePct: number | null };
  /** 两市成交额（亿元），与录入「成交量」同口径 */
  turnover: number | null;
  turnoverSse: number | null;
  /** 两市主力净流入（亿元），与录入「主力资金」同口径 */
  mainCapital: number | null;
  mainCapitalSse: number | null;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  history: MarketHistoryPoint[];
  /** 数据来源：network=本次实时拉取，disk=本地缓存（未过期），stale=接口失败降级用本地数据 */
  source: 'network' | 'disk' | 'stale';
  /** 是否降级：为 true 时说明这不是实时数据，界面必须提示 */
  stale: boolean;
  note?: string;
}

export async function fetchMarketSnapshot(days = 150): Promise<MarketSnapshot> {
  const res = await fetch(`/api/market?days=${days}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `大盘数据获取失败（HTTP ${res.status}）`);
  }
  return res.json();
}
