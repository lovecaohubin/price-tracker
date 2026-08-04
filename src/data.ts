import { Asset } from './types';

// 生成模拟价格走势（30天）
function generatePriceHistory(basePrice: number, volatility: number): { date: string; price: number }[] {
  const history = [];
  let price = basePrice * (0.85 + Math.random() * 0.1);
  const now = new Date();

  for (let i = 30; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const change = (Math.random() - 0.48) * volatility * price;
    price = Math.max(price + change, basePrice * 0.5);
    history.push({
      date: date.toISOString().slice(0, 10),
      price: Math.round(price * 100) / 100,
    });
  }
  return history;
}

export const defaultAssets: Asset[] = [
  {
    id: '1',
    name: '苹果',
    symbol: 'AAPL',
    type: 'stock',
    currentPrice: 187.35,
    high52Week: 199.62,
    allTimeHigh: 199.62,
    changePercent: 1.24,
    priceHistory: generatePriceHistory(187, 5),
  },
  {
    id: '2',
    name: '英伟达',
    symbol: 'NVDA',
    type: 'stock',
    currentPrice: 128.44,
    high52Week: 140.76,
    allTimeHigh: 140.76,
    changePercent: -2.15,
    priceHistory: generatePriceHistory(128, 8),
  },
  {
    id: '3',
    name: '特斯拉',
    symbol: 'TSLA',
    type: 'stock',
    currentPrice: 245.30,
    high52Week: 299.29,
    allTimeHigh: 414.50,
    changePercent: 3.67,
    priceHistory: generatePriceHistory(245, 15),
  },
  {
    id: '4',
    name: '比特币',
    symbol: 'BTC',
    type: 'crypto',
    currentPrice: 67420.50,
    high52Week: 73776.00,
    allTimeHigh: 73776.00,
    changePercent: 0.85,
    priceHistory: generatePriceHistory(67420, 2000),
  },
  {
    id: '5',
    name: '以太坊',
    symbol: 'ETH',
    type: 'crypto',
    currentPrice: 3520.75,
    high52Week: 4091.28,
    allTimeHigh: 4891.70,
    changePercent: -1.33,
    priceHistory: generatePriceHistory(3520, 150),
  },
  {
    id: '6',
    name: '谷歌',
    symbol: 'GOOGL',
    type: 'stock',
    currentPrice: 178.90,
    high52Week: 179.85,
    allTimeHigh: 179.85,
    changePercent: 0.52,
    priceHistory: generatePriceHistory(178, 4),
  },
];

// 获取所有可选资产（用于添加）
export const availableAssets = [
  { name: '微软', symbol: 'MSFT', type: 'stock' as const, basePrice: 420 },
  { name: '亚马逊', symbol: 'AMZN', type: 'stock' as const, basePrice: 185 },
  { name: 'Meta', symbol: 'META', type: 'stock' as const, basePrice: 510 },
  { name: '币安币', symbol: 'BNB', type: 'crypto' as const, basePrice: 580 },
  { name: 'Solana', symbol: 'SOL', type: 'crypto' as const, basePrice: 145 },
  { name: '台积电', symbol: 'TSM', type: 'stock' as const, basePrice: 160 },
  { name: 'AMD', symbol: 'AMD', type: 'stock' as const, basePrice: 150 },
  { name: '狗狗币', symbol: 'DOGE', type: 'crypto' as const, basePrice: 0.12 },
];

export function createNewAsset(name: string, symbol: string, type: 'stock' | 'crypto', basePrice: number): Asset {
  const high = basePrice * (1 + Math.random() * 0.4);
  return {
    id: Date.now().toString(),
    name,
    symbol,
    type,
    currentPrice: basePrice,
    high52Week: high,
    allTimeHigh: high * (1 + Math.random() * 0.5),
    changePercent: Math.round((Math.random() * 6 - 3) * 100) / 100,
    priceHistory: generatePriceHistory(basePrice, basePrice * 0.05),
  };
}
