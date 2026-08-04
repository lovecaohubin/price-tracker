import { Asset, PricePoint } from '../types';

// 新浪行情数据字段解析
// 0:名称 1:今开 2:昨收 3:当前价 4:最高 5:最低 6:竞买价 7:竞卖价
// 8:成交数(手) 9:成交额(万) 30:日期 31:时间 32:停牌状态
function parseSinaQuote(raw: string): {
  name: string; currentPrice: number; open: number; yesterdayClose: number;
  high: number; low: number; changePercent: number; volume: number; amount: number;
} | null {
  try {
    const match = raw.match(/"([^"]*)"/);
    if (!match) return null;
    const fields = match[1].split(',');
    if (fields.length < 33) return null;

    const name = fields[0];
    const open = parseFloat(fields[1]) || 0;
    const yesterdayClose = parseFloat(fields[2]) || 0;
    const currentPrice = parseFloat(fields[3]) || 0;
    const high = parseFloat(fields[4]) || 0;
    const low = parseFloat(fields[5]) || 0;
    const volume = parseFloat(fields[8]) || 0;
    const amount = parseFloat(fields[9]) || 0;

    const changePercent = yesterdayClose > 0
      ? ((currentPrice - yesterdayClose) / yesterdayClose * 100)
      : 0;

    return { name, currentPrice, open, yesterdayClose, high, low, changePercent, volume, amount };
  } catch {
    return null;
  }
}

// 批量获取实时行情（新浪接口）
export async function fetchQuotes(symbols: string[]): Promise<Map<string, ReturnType<typeof parseSinaQuote>>> {
  const result = new Map<string, ReturnType<typeof parseSinaQuote>>();
  if (symbols.length === 0) return result;

  // 新浪接口格式：sh600519,sz000001
  const sinaCodes = symbols.map(s => {
    const code = s.replace(/\D/g, '');
    if (s.startsWith('sh') || code.startsWith('6')) return `sh${code}`;
    return `sz${code}`;
  });

  try {
    const url = `/api/sina/list=${sinaCodes.join(',')}`;
    const resp = await fetch(url, {
      headers: { Referer: 'https://finance.sina.com.cn' },
    });
    const text = await resp.text();

    // 按行解析每只股票
    const lines = text.split('\n').filter((l: string) => l.trim());
    lines.forEach((line: string, i: number) => {
      const data = parseSinaQuote(line);
      if (data && i < symbols.length) {
        result.set(symbols[i], data);
      }
    });
  } catch (e) {
    console.error('获取行情失败:', e);
  }

  return result;
}

// 获取 K 线数据（东方财富接口）
// secid: 1.600519 (沪市) 或 0.000001 (深市)
export async function fetchKLine(symbol: string, days = 250): Promise<PricePoint[]> {
  const code = symbol.replace(/\D/g, '');
  const market = code.startsWith('6') || code.startsWith('5') || code.startsWith('9')
    ? '1' : '0';
  const secid = `${market}.${code}`;

  try {
    const url = `/api/em/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=${days}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const json = await resp.json();
    if (!json?.data?.klines) return [];

    const klines: string[] = json.data.klines;
    return klines.map((line: string) => {
      const [date, open, close, high, low, volume] = line.split(',');
      return {
        date,
        price: parseFloat(close),
      };
    });
  } catch (e) {
    console.error(`获取 ${symbol} K线失败:`, e);
    return [];
  }
}

// 计算 52 周最高价（基于 K 线数据）
export function calc52WeekHigh(klines: PricePoint[]): number {
  if (klines.length === 0) return 0;
  let max = 0;
  for (const k of klines) {
    if (k.price > max) max = k.price;
  }
  return max;
}

// 完整获取一只 A 股的数据
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
