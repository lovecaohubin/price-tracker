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
  turnoverRate: number;       // 换手率 %
  lowSince2000: number;       // 2000年以来历史最低

}

export interface PricePoint {
  date: string;
  price: number;
}

// 排序方式
export type SortField = 'name' | 'currentPrice' | 'high52Week' | 'allTimeHigh' | 'changePercent';
export type SortDirection = 'asc' | 'desc';

// 交易记录（原桌面 XLS「风险控制」表，现由页面录入维护）
// 所有金额单位为元，比率类字段以小数存储（如 -0.038 表示 -3.8%）
export interface TradeRecord {
  id: string;
  seq: number;                     // 序号
  date: string;                    // 日期 YYYY-MM-DD
  principal: number | null;        // 本金
  leverage: number | null;         // 杠杆资金
  totalAmount: number | null;      // 总金额
  currentAmount: number | null;    // 当前金额
  dayPnl: number | null;           // 当日盈亏
  cumPnl: number | null;           // 累计盈亏
  cumPnlRate: number | null;       // 累计盈亏比
  marketValue1: number | null;     // 市值1
  marketValue2: number | null;     // 市值2
  positionRate: number | null;     // 仓位
  turnover: number | null;         // 成交量
  vsPrevDay: number | null;        // 较上一日
  changePct: number | null;        // 涨幅
  mainCapital: number | null;      // 主力资金
  outflowRatio: number | null;     // 主流流出比
  sseIndex: number | null;         // 上证指数
  plan: string;                    // 次日交易计划
  review: string;                  // 复盘
}

export type TradeRecordField = Exclude<keyof TradeRecord, 'id' | 'seq' | 'date' | 'plan' | 'review'>;
