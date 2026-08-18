import { Asset, PricePoint } from '../types';

// 腾讯行情 API 字段索引（~ 分隔，UTF-8）
// 0=市场, 1=名称, 2=代码, 3=最新价, 4=昨收, 5=今开, 31=涨跌额, 32=涨跌幅%, 33=最高, 34=最低, 38=换手率%
const FIELD = { NAME: 1, CODE: 2, PRICE: 3, YESTERDAY: 4, OPEN: 5, CHG_PCT: 32, CHG_AMT: 31, HIGH: 33, LOW: 34, TURNOVER: 38 };

interface QuoteResult {
  name: string;
  currentPrice: number;
  open: number;
  yesterdayClose: number;
  high: number;
  low: number;
  changePercent: number;
  turnoverRate: number;
}

// 批量获取实时行情（腾讯 API，UTF-8，无乱码）
export async function fetchQuotes(symbols: string[]): Promise<Map<string, QuoteResult>> {
  const result = new Map<string, QuoteResult>();
  if (symbols.length === 0) return result;

  const codes = symbols.join(',');
  const url = `/api/gtimg/utf8/q=${codes}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) return result;
    const text = await resp.text();

    // 解析格式: v_sh603248="1~锡华科技~603248~19.48~..."
    const lines = text.trim().split('\n');
    for (const line of lines) {
      const match = line.match(/v_(\w+)="(.+)"/);
      if (!match) continue;

      const rawSymbol = match[1]; // sh603248
      const fields = match[2].split('~');
      if (fields.length < 35) continue;

      // 找到对应的完整 symbol
      const symbol = symbols.find(s => s.toLowerCase() === rawSymbol.toLowerCase());
      if (!symbol) continue;

      result.set(symbol, {
        name: fields[FIELD.NAME] || symbol,
        currentPrice: parseFloat(fields[FIELD.PRICE]) || 0,
        open: parseFloat(fields[FIELD.OPEN]) || 0,
        yesterdayClose: parseFloat(fields[FIELD.YESTERDAY]) || 0,
        high: parseFloat(fields[FIELD.HIGH]) || 0,
        low: parseFloat(fields[FIELD.LOW]) || 0,
        changePercent: parseFloat(fields[FIELD.CHG_PCT]) || 0,
        turnoverRate: parseFloat(fields[FIELD.TURNOVER]) || 0,
      });
    }
  } catch (e) {
    console.error('获取行情失败:', e);
  }

  return result;
}

// 从 K线 JSON 解析最高价
function calcMaxHigh(rawKlines: string[][]): number {
  let max = 0;
  for (const k of rawKlines) {
    const dayHigh = parseFloat(k[3]) || 0;
    if (dayHigh > max) max = dayHigh;
  }
  return max;
}

// 从 K线 JSON 解析最低价（忽略无效值）
function calcMinLow(rawKlines: string[][]): number {
  let min = Infinity;
  for (const k of rawKlines) {
    const dayLow = parseFloat(k[4]) || 0;
    if (dayLow > 0 && dayLow < min) min = dayLow;
  }
  return min === Infinity ? 0 : min;
}

// 从 K线 JSON 提取最近 N 条收盘价
function extractPrices(rawKlines: string[][], count: number): PricePoint[] {
  const result: PricePoint[] = [];
  const slice = rawKlines.slice(-count);
  for (const k of slice) {
    result.push({ date: k[0], price: parseFloat(k[2]) || 0 });
  }
  return result;
}

// 完整获取一只股票的数据
// 日线：算 52 周新高 + 走势图；周线：算历史最高/最低（2000 年起，覆盖约 27 年）
export async function fetchAssetData(symbol: string): Promise<Partial<Asset> | null> {
  const quotes = await fetchQuotes([symbol]);
  const quote = quotes.get(symbol);
  if (!quote) return null;

  const code = symbol.toLowerCase();
  let high52Week = quote.high;
  let allTimeHigh = quote.high;
  let lowSince2000 = quote.low;
  const recentKlines: PricePoint[] = [];

  try {
    // 日线：52周新高 + 30天走势图
    const dayResp = await fetch(`/api/kline?symbol=${code}&period=day`);
    if (dayResp.ok) {
      const json = await dayResp.json();
      const stockData = json.data?.[code];
      if (json.code === 0 && stockData && typeof stockData === 'object') {
        const raw: string[][] = stockData.qfqday || stockData.day || [];
        console.log(`[${symbol}] 日线 ${raw.length} 条`);

        const oneYearKlines = raw.slice(-250);
        high52Week = calcMaxHigh(oneYearKlines);
        if (quote.high > high52Week) high52Week = quote.high;

        recentKlines.push(...extractPrices(raw, 30));
      }
    }

    // 周线：历史最高/最低（从 2000 年起，覆盖约 27 年）
    const weekResp = await fetch(`/api/kline?symbol=${code}&period=week`);
    if (weekResp.ok) {
      const json = await weekResp.json();
      const stockData = json.data?.[code];
      if (json.code === 0 && stockData && typeof stockData === 'object') {
        const raw: string[][] = stockData.week || stockData.qfqweek || [];
        console.log(`[${symbol}] 周线 ${raw.length} 条`);

        allTimeHigh = calcMaxHigh(raw);
        if (quote.high > allTimeHigh) allTimeHigh = quote.high;

        // 2000 年以来历史最低（与当日最低取较小值）
        const weekMin = calcMinLow(raw);
        if (weekMin > 0) {
          lowSince2000 = lowSince2000 > 0 ? Math.min(lowSince2000, weekMin) : weekMin;
        }
      }
    }

    console.log(`[${symbol}] 今日:${quote.high}  52周新高:${high52Week}  历史最高:${allTimeHigh}  历史最低:${lowSince2000}  当前价:${quote.currentPrice}`);
  } catch (e) {
    console.error(`[${symbol}] K线请求失败:`, e);
  }

  return {
    name: quote.name,
    symbol,
    currentPrice: quote.currentPrice,
    high52Week: high52Week || quote.high,
    allTimeHigh: allTimeHigh || quote.high,
    lowSince2000: lowSince2000 || quote.low,
    changePercent: Math.round(quote.changePercent * 100) / 100,
    priceHistory: recentKlines,
    turnoverRate: Math.round(quote.turnoverRate * 100) / 100,
  };
}
