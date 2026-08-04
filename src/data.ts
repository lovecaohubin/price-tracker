import { Asset } from './types';

// A股默认跟踪资产（仅做占位，实际数据由 API 填充）
export const defaultAShareSymbols = [
  'sh603248',  // 中岩大地
  'sz000690',  // 宝新能源
  'sz300847',  // 中船汉光
  'sh603267',  // 鸿远电子
  'sz000858',  // 五粮液
];

// 可选添加的A股列表
export const availableAShares = [
  { name: '中岩大地', symbol: 'sh603248' },
  { name: '宝新能源', symbol: 'sz000690' },
  { name: '中船汉光', symbol: 'sz300847' },
  { name: '鸿远电子', symbol: 'sh603267' },
  { name: '五粮液',   symbol: 'sz000858' },
  { name: '贵州茅台', symbol: 'sh600519' },
  { name: '中国平安', symbol: 'sh601318' },
  { name: '宁德时代', symbol: 'sz300750' },
  { name: '比亚迪',   symbol: 'sz002594' },
  { name: '招商银行', symbol: 'sh600036' },
  { name: '长江电力', symbol: 'sh600900' },
  { name: '中芯国际', symbol: 'sh688981' },
  { name: '药明康德', symbol: 'sh603259' },
  { name: '恒瑞医药', symbol: 'sh600276' },
  { name: '美的集团', symbol: 'sz000333' },
  { name: '格力电器', symbol: 'sz000651' },
  { name: '中国石油', symbol: 'sh601857' },
  { name: '中国移动', symbol: 'sh600941' },
  { name: '工商银行', symbol: 'sh601398' },
  { name: '农业银行', symbol: 'sh601288' },
  { name: '中国神华', symbol: 'sh601088' },
  { name: '海康威视', symbol: 'sz002415' },
  { name: '隆基绿能', symbol: 'sh601012' },
  { name: '中兴通讯', symbol: 'sz000063' },
  { name: '东方财富', symbol: 'sz300059' },
  { name: '中国中免', symbol: 'sh601888' },
  { name: '邮储银行', symbol: 'sh601658' },
  { name: '中国中铁', symbol: 'sh601390' },
];

// 创建占位资产（API数据加载前显示）
export function createPlaceholder(symbol: string): Asset {
  const info = availableAShares.find(a => a.symbol === symbol);
  return {
    id: symbol,
    name: info?.name || symbol,
    symbol,
    type: 'stock',
    currentPrice: 0,
    high52Week: 0,
    allTimeHigh: 0,
    changePercent: 0,
    priceHistory: [],
  };
}
