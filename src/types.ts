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

// ===== 股票分析模块（每日 15:01 收盘后自动生成）=====
// 与 holdAdvice / positionAdvice 一样只做强弱与风险刻度，不预测涨跌。

/** 当日行情底色（东财 ulist 快照） */
export interface StockReportQuote {
  close: number;          // 收盘价
  prevClose: number;      // 昨收
  open: number;
  high: number;
  low: number;
  changePct: number;      // 涨跌幅（小数，如 -0.013）
  amplitude: number;      // 振幅（小数）
  turnoverYi: number | null;   // 成交额（亿元）
  turnoverRate: number | null; // 换手率 %
  volumeRatio: number | null;  // 量比
  peTtm: number | null;
  peStatic: number | null;
  peDynamic: number | null;
  pb: number | null;
  marketCapTotalYi: number | null;  // 总市值（亿元）
  marketCapFloatYi: number | null;  // 流通市值（亿元）
}

/** 当日资金流向（东财 fflow，单位元；null=取不到） */
export interface StockReportFlow {
  main: number | null;      // 主力净流入
  super: number | null;     // 超大单
  big: number | null;       // 大单
  mid: number | null;       // 中单
  small: number | null;     // 小单（散户）
  main5d: number | null;    // 近 5 日主力净流入合计
  /** 主力净占比（小数，f57，=主力净流入 / 总成交额） */
  mainRatio: number | null;
  /** 数据源/口径标注（前端展示） */
  sourceLabel: string;
  methodologyNote: string;
}

/** 龙虎榜席位类型 */
export type LhbSeatType = 'institutional' | 'foreign' | 'other'

/** 当日龙虎榜（一票可因多原因上榜，故为数组） */
export interface StockReportLhbItem {
  reason: string;
  buyYi: number;
  sellYi: number;
  netYi: number;
  dealAmtYi: number;      // 上榜成交额
  buyRatio: number | null;   // 买入占成交额比例（小数）
}

/** 龙虎榜席位（含类型识别） */
export interface LhbSeat {
  name: string;
  amtYi: number;          // 净额（亿）= 买入金额 - 卖出金额
  riseProb3d: number | null; // 历史统计 3 日上涨概率（%，仅买席有）
  type: LhbSeatType;
}

export interface StockReportLhb {
  items: StockReportLhbItem[];
  buySeats: LhbSeat[];
  sellSeats: LhbSeat[];
  /** 机构专用席位（汇总净买卖） */
  institutional: { name: string; netYi: number; riseProb3d: number | null }[];
  /** 外资席位（高盛/瑞银/JPMorgan 等） */
  foreign: { name: string; netYi: number; riseProb3d: number | null }[];
  /** 近 10 次上榜历史（日期/原因/净买卖/涨跌幅） */
  history: { date: string; reason: string; netYi: number; changePct: number | null }[];
  count30d: number | null;
}

/** 融资融券（T+1 披露，最新为上一交易日） */
export interface StockReportRzrq {
  date: string;
  rzyeYi: number | null;     // 融资余额（亿元）
  rzjmeYi: number | null;    // 融资净买入（亿元，负=净偿还）
  rzmreYi: number | null;    // 融资买入额
  rzcheYi: number | null;    // 融资偿还额
  rqylWan: number | null;    // 融券余量（万股）
  downDays: number | null;   // 融资净偿还连续天数（0=当日净买入）
}

/** 大宗交易 */
export interface StockReportBlockTradeItem {
  date: string;
  price: number;
  premiumPct: number | null;  // 成交价相对收盘溢价（小数）
  amountYi: number;
  buyer: string | null;
  seller: string | null;
}

/** 十大流通股东（最新披露期） */
export interface StockReportHolderItem {
  name: string;
  holdNumWan: number;         // 持股（万股）
  ratio: number | null;       // 占流通股比例（小数）
  changeWan: number | null;   // 环比变动（万股，null=新进）
  state: string;              // 加仓 / 减仓 / 新进 / 不变
  type: string | null;        // QFII / 个人 / 基金…
  reportDate: string;         // 披露期，如 2026-06-30
}

/** 技术指标（由日 K 本地计算） */
export interface StockReportTech {
  rsi6: number | null;
  rsi12: number | null;
  rsi24: number | null;
  kdjK: number | null;
  kdjD: number | null;
  kdjJ: number | null;
  bollUp: number | null;
  bollMid: number | null;
  bollLow: number | null;
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
  ma250: number | null;
}

/** 单只股票的完整日度分析报告 */
export interface StockReport {
  symbol: string;
  name: string;
  date: string;            // 交易日 YYYY-MM-DD
  generatedAt: string;     // ISO 时间
  quote: StockReportQuote | null;
  flow: StockReportFlow | null;
  lhb: StockReportLhb | null;
  rzrq: StockReportRzrq | null;
  blockTrades: StockReportBlockTradeItem[] | null;
  holders: StockReportHolderItem[] | null;
  tech: StockReportTech | null;
  /** 规则生成的解读要点（不做涨跌预测） */
  insights: string[];
  /** 取数失败的板块名 */
  missing: string[];
}

/** 单日全部跟踪标的的报告集合 */
export interface StockReportDay {
  date: string;
  generatedAt: string;
  reports: StockReport[];
}

/** 服务端落盘的存储结构（data/stockAnalysis.json） */
export interface StockAnalysisStore {
  savedAt: number;
  symbols: string[];
  /** 上次成功生成的时间戳（ms），用于 15:01 调度器判重 */
  lastRunAt?: number;
  days: Record<string, StockReportDay>;
}

// ===== 首版涨停模块（实时，无缓存落盘） =====
// "首版涨停"指个股本次连板中第 1 个涨停板（区别于"连板涨停"）。
// 数据源：东财 push2 涨停股池（涨幅排序前 N，f2 == f15 表示封板）；
// 首板判定：当日涨停 & 昨日收盘价未达到涨停位。

/** 涨停股票列表条目（首版第一屏） */
export interface ZtListItem {
  /** 6 位代码 */
  code: string;
  /** 名称 */
  name: string;
  /** 市场，0=深 / 1=沪 / 2=京 / 5=基金 / ... */
  market: number;
  /** 最新价（元，未除权） */
  price: number;
  /** 涨跌幅（小数） */
  changePct: number;
  /** 涨跌额（元） */
  changeAmt: number;
  /** 成交量（手） */
  volumeHands: number;
  /** 成交额（元） */
  turnover: number;
  /** 振幅（小数） */
  amplitude: number;
  /** 总市值（元） */
  marketCap: number;
  /** 换手率（%） */
  turnoverRate: number | null;
  /** 量比 */
  volumeRatio: number | null;
  /** 所属行业（来自 ulist.f100） */
  industry: string | null;
  /** 封单金额（元；>0 即封板） */
  sealedAmt: number | null;
  /** 主力净流入（元） */
  mainNet: number | null;
  /** 是否首板（与昨日比较） */
  isFirstBoard: boolean;
  /** 连续涨停次数（>= 1；首板 = 1） */
  boardCount: number;
  /** 板块代码 sh/sz 已加前缀（如 sh603248） */
  symbol: string;
}

/** 首版涨停列表接口响应 */
export interface ZtListResponse {
  /** 全市场涨停股（含首板 / 连板），按涨幅降序 */
  items: ZtListItem[];
  /** 仅首板过滤后的列表 */
  firstBoard: ZtListItem[];
  /** 拉取时间（ISO） */
  fetchedAt: string;
  /** 行情快照时间（YYYY-MM-DD） */
  tradeDate: string;
  /** 数据源 / 字段说明（前端展示） */
  note: string;
  /** 接口是否降级（拉取部分失败但仍可用） */
  stale?: boolean;
}

/** 涨停股票详情（点击列表项后展示） */
export interface ZtDetailItem extends ZtListItem {
  /** 当日 K 线（开 / 高 / 低 / 收） */
  ohlc: { open: number; high: number; low: number; close: number };
  /** 昨收价 */
  prevClose: number;
  /** 当日涨停价（按个股交易档/创业板/科创板精确计算） */
  limitUpPrice: number;
  /** 当日资金流向（fflow，元） */
  flow: {
    main: number | null;     // 主力
    super: number | null;    // 超大单
    big: number | null;      // 大单
    mid: number | null;      // 中单
    small: number | null;    // 小单
    main5d: number | null;   // 近 5 日主力合计
  };
  /** 龙虎榜（可能为 null：未上榜） */
  lhb: ZtLhbSummary | null;
  /** 融资融券（T+1，可能为 null） */
  rzrq: ZtRzrqSummary | null;
  /** 大宗交易（可能为空数组） */
  blockTrades: ZtBlockTradeSummary[];
}

/** 龙虎榜（精简版，仅展示买入前五 / 卖出前五 / 机构 / 外资） */
export interface ZtLhbSummary {
  date: string;
  reason: string;
  buyAmtYi: number;
  sellAmtYi: number;
  netYi: number;
  /** 买入前五席位（含 name / netYi / riseProb3d） */
  buySeats: { name: string; netYi: number; riseProb3d: number | null }[];
  /** 卖出前五 */
  sellSeats: { name: string; netYi: number }[];
  /** 机构专用席位 */
  institutional: { name: string; netYi: number }[];
  /** 外资席位 */
  foreign: { name: string; netYi: number }[];
  /** 近 1 月上榜次数 */
  count30d: number | null;
}

/** 融资融券（精简） */
export interface ZtRzrqSummary {
  date: string;
  rzyeYi: number | null;
  rzjmeYi: number | null;
  rqylWan: number | null;
  downDays: number;
}

/** 大宗交易（精简） */
export interface ZtBlockTradeSummary {
  date: string;
  price: number;
  premiumPct: number | null;
  amountYi: number;
  buyer: string | null;
  seller: string | null;
}

/** 详情接口响应 */
export interface ZtDetailResponse {
  item: ZtDetailItem;
  fetchedAt: string;
  /** 数据源说明 */
  sources: { flow: string; lhb: string; rzrq: string; blockTrades: string };
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
  currentAmountPart1: number | null;  // 当前金额①（手工录入）
  currentAmountPart2: number | null;  // 当前金额②（手工录入）
  currentAmount: number | null;    // 当前金额 = ① + ②（页面自动求和）
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
