import { Asset, PricePoint } from '../types';

// 将 "sh603248" 转为东方财富 secid 格式：沪市 "1.603248"，深市 "0.000690"
function toSecid(symbol: string): string {
  const code = symbol.replace(/\D/g, '');
  // 沪市：6xxxxx, 5xxxxx, 9xxxxx
  if (code.startsWith('6') || code.startsWith('5') || code.startsWith('9')) {
    return `1.${code}`;
  }
  // 深市：0xxxxx, 3xxxxx, 2xxxxx
  return `0.${code}`;
}

interface QuoteResult {
  name: string;
  currentPrice: number;
  open: number;
  yesterdayClose: number;
  high: number;
  low: number;
  changePercent: number;
}

// 批量获取实时行情（东方财富，JSON格式，UTF-8，无乱码）
export async function fetchQuotes(symbols: string[]): Promise<Map<string, QuoteResult>> {
  const result = new Map<string, QuoteResult>();
  if (symbols.length === 0) return result;

  const secids = symbols.map(toSecid).join(',');
  // f2=最新价 f3=涨跌幅 f4=涨跌额 f12=代码 f14=名称 f15=最高 f16=最低 f17=今开 f18=昨收
  const fields = 'f2,f3,f4,f12,f14,f15,f16,f17,f18';

  try {
    const url = `/api/em-quote/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=${fields}`;
    const resp = await fetch(url);
    if (!resp.ok) return result;
    const json = await resp.json();
    if (!json?.data?.diff) return result;

    const diffMap: Record<string, Record<string, unknown>> = {};
    for (const item of json.data.diff) {
      diffMap[item.f12 as string] = item;
    }

    for (const symbol of symbols) {
      const code = symbol.replace(/\D/g, '');
      const item = diffMap[code];
      if (!item) continue;

      const currentPrice = (item.f2 as number) || 0;
      const yesterdayClose = (item.f18 as number) || 0;
      const changePercent = (item.f3 as number) || 0;

      result.set(symbol, {
        name: String(item.f14 || symbol),
        currentPrice,
        open: (item.f17 as number) || 0,
        yesterdayClose,
        high: (item.f15 as number) || 0,
        low: (item.f16 as number) || 0,
        changePercent,
      });
    }
  } catch (e) {
    console.error('获取行情失败:', e);
  }

  return result;
}

// 获取 K 线数据（东方财富，JSON 格式）
export async function fetchKLine(symbol: string, days = 250): Promise<PricePoint[]> {
  const secid = toSecid(symbol);

  try {
    const url = `/api/em-kline/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=${days}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const json = await resp.json();
    if (!json?.data?.klines) return [];

    const klines: string[] = json.data.klines;
    return klines.map((line: string) => {
      const [date, , close] = line.split(',');
      return { date, price: parseFloat(close) };
    });
  } catch (e) {
    console.error(`获取 ${symbol} K线失败:`, e);
    return [];
  }
}

// 计算 52 周最高价
export function calc52WeekHigh(klines: PricePoint[]): number {
  if (klines.length === 0) return 0;
  let max = 0;
  for (const k of klines) {
    if (k.price > max) max = k.price;
  }
  return max;
}

// 完整获取一只股票的数据
export async function fetchAssetData(symbol: string): Promise<Partial<Asset> | null> {
  const quotes = await fetchQuotes([symbol]);
  const quote = quotes.get(symbol);
  if (!quote) return null;

  const klines = await fetchKLine(symbol, 250);
  const high52Week = calc52WeekHigh(klines);
  const recentKlines = klines.slice(-30);

  return {
    name: quote.name,
    symbol,
    type: 'stock',
    currentPrice: quote.currentPrice,
    high52Week: high52Week || quote.high,
    allTimeHigh: high52Week || quote.high,
    changePercent: Math.round(quote.changePercent * 100) / 100,
    priceHistory: recentKlines,
  };
}
