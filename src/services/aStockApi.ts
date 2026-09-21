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

// K 线本地缓存：轮询时不必重复拉取全量历史数据
// 周线(每资产约 110KB)历史数据几乎不变，只拉一次；日线 60 秒内复用
const weekRowCache = new Map<string, string[][]>();
const dayRowCache = new Map<string, { rows: string[][]; at: number }>();
const DAY_ROW_TTL = 60 * 1000;

// 拉取并解析 K 线（东方财富每行为 CSV: 日期,开,收,高,低,量,额,振幅,涨跌幅,涨跌额,换手率）
// 返回 stale=true 表示数据来自中间件本地缓存（非交易日 / 接口限流时降级），
// 调用于区分实时/降级——资产卡片的"更新于"时间戳由调用层自行处理，这里只把信号透出来。
async function loadKlineRows(
  symbol: string,
  period: 'day' | 'week',
): Promise<{ rows: string[][] | null; stale: boolean }> {
  if (period === 'week') {
    const hit = weekRowCache.get(symbol);
    if (hit) return { rows: hit, stale: false };
  } else {
    const hit = dayRowCache.get(symbol);
    if (hit && Date.now() - hit.at < DAY_ROW_TTL) return { rows: hit.rows, stale: false };
  }

  try {
    const resp = await fetch(`/api/kline?symbol=${symbol}&period=${period}`);
    const isStale = resp.headers.get('X-Kline-Cache') === 'STALE';
    if (!resp.ok) return { rows: null, stale: false };

    const json = await resp.json();
    const klines: unknown = json?.data?.klines;
    if (!Array.isArray(klines)) return { rows: null, stale: isStale };

    const rows = (klines as string[]).map(line => String(line).split(','));
    if (period === 'week') weekRowCache.set(symbol, rows);
    else dayRowCache.set(symbol, { rows, at: Date.now() });
    if (isStale) console.warn(`[${symbol}] ${period} K线取自本地缓存（非交易日 / 接口失败降级）`);
    return { rows, stale: isStale };
  } catch (e) {
    console.error(`[${symbol}] ${period} K线请求失败:`, e);
    return { rows: null, stale: false };
  }
}

// 回测需要完整历史（近 300 根日 K），不能只用 fetchAssetData 返回的 30 天收盘价，
// 因此单独暴露原始 K 线行；复用同一份内存缓存，不会额外打接口
export async function fetchKlineRows(
  symbol: string,
  period: 'day' | 'week' = 'day',
): Promise<{ rows: string[][] | null; stale: boolean }> {
  return loadKlineRows(symbol.toLowerCase(), period);
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
// 日线(近300个交易日)：算 52 周新高(真实价) + 30天走势图；周线(不复权，2000年以来)：算历史最高/最低
// quote 可由调用方批量获取后传入，避免每个资产单独发一次行情请求
export async function fetchAssetData(symbol: string, externalQuote?: QuoteResult): Promise<Partial<Asset> | null> {
  let quote = externalQuote;
  if (!quote) {
    const quotes = await fetchQuotes([symbol]);
    quote = quotes.get(symbol);
  }
  if (!quote) return null;

  const q = quote;
  const code = symbol.toLowerCase();
  let high52Week = q.high;
  let allTimeHigh = q.high;
  let lowSince2000 = q.low;
  const recentKlines: PricePoint[] = [];

  try {
    // 日线(不复权)：52周新高(近250个交易日) + 近30天走势图
    const dayResult = await loadKlineRows(code, 'day');
    const dayRows = dayResult.rows;
    if (dayRows) {
      console.log(`[${symbol}] 日线 ${dayRows.length} 条`);

      const oneYearKlines = dayRows.slice(-250);
      high52Week = calcMaxHigh(oneYearKlines);
      if (q.high > high52Week) high52Week = q.high;

      recentKlines.push(...extractPrices(dayRows, 30));
    }

    // 周线(不复权)：历史最高 + 2000年以来历史最低
    const weekResult = await loadKlineRows(code, 'week');
    const weekRows = weekResult.rows;
    if (weekRows) {
      console.log(`[${symbol}] 周线 ${weekRows.length} 条`);

      // 历史最高：取全部可得数据的最高价
      allTimeHigh = calcMaxHigh(weekRows);
      if (q.high > allTimeHigh) allTimeHigh = q.high;

      // 2000 年以来历史最低（过滤 2000-01-01 之前的周K，与当日最低取较小值）
      const since2000 = weekRows.filter(k => (k[0] || '') >= '2000-01-01');
      const weekMin = calcMinLow(since2000.length > 0 ? since2000 : weekRows);
      if (weekMin > 0) {
        lowSince2000 = lowSince2000 > 0 ? Math.min(lowSince2000, weekMin) : weekMin;
      }
    }

    console.log(`[${symbol}] 今日:${q.high}  52周新高:${high52Week}  历史最高:${allTimeHigh}  历史最低:${lowSince2000}  当前价:${q.currentPrice}`);
  } catch (e) {
    console.error(`[${symbol}] K线请求失败:`, e);
  }

  return {
    name: q.name,
    symbol,
    currentPrice: q.currentPrice,
    high52Week: high52Week || q.high,
    allTimeHigh: allTimeHigh || q.high,
    lowSince2000: lowSince2000 || q.low,
    changePercent: Math.round(q.changePercent * 100) / 100,
    priceHistory: recentKlines,
    turnoverRate: Math.round(q.turnoverRate * 100) / 100,
  };
}
