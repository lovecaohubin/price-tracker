// 资产数据类型
export interface Asset {
  id: string;
  name: string;           // 名称，如 "苹果"
  symbol: string;         // 代码，如 "AAPL"
  type: 'stock' | 'crypto' | 'etf';  // 类型
  currentPrice: number;   // 当前价格
  high52Week: number;     // 52周新高
  allTimeHigh: number;    // 历史最高
  changePercent: number;  // 今日涨跌幅 %
  priceHistory: PricePoint[];  // 近30天价格走势
  turnoverRate: number;   // 换手率 %

}

export interface PricePoint {
  date: string;
  price: number;
}

// 排序方式
export type SortField = 'name' | 'currentPrice' | 'high52Week' | 'allTimeHigh' | 'changePercent';
export type SortDirection = 'asc' | 'desc';
