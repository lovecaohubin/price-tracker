import { TradeRecord } from '../types';

// 导出字段顺序与表头（pct 字段按百分数导出，与页面展示一致）
const EXPORT_COLUMNS: { key: keyof TradeRecord; label: string; pct?: boolean }[] = [
  { key: 'seq', label: '序号' },
  { key: 'date', label: '日期' },
  { key: 'principal', label: '本金' },
  { key: 'leverage', label: '杠杆资金' },
  { key: 'totalAmount', label: '总金额' },
  { key: 'currentAmountPart1', label: '当前金额①' },
  { key: 'currentAmountPart2', label: '当前金额②' },
  { key: 'currentAmount', label: '当前金额合计' },
  { key: 'dayPnl', label: '当日盈亏' },
  { key: 'cumPnl', label: '累计盈亏' },
  { key: 'cumPnlRate', label: '累计盈亏比(%)', pct: true },
  { key: 'marketValue1', label: '市值1' },
  { key: 'marketValue2', label: '市值2' },
  { key: 'positionRate', label: '仓位(%)', pct: true },
  { key: 'turnover', label: '成交量' },
  { key: 'vsPrevDay', label: '较上一日' },
  { key: 'changePct', label: '涨幅(%)', pct: true },
  { key: 'mainCapital', label: '主力资金' },
  { key: 'outflowRatio', label: '主流流出比(%)', pct: true },
  { key: 'sseIndex', label: '上证指数' },
  { key: 'plan', label: '次日交易计划' },
  { key: 'review', label: '复盘' },
];

// CSV 字段转义：含逗号/引号/换行的值用双引号包裹，内部引号翻倍
export function csvCell(v: string | number | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// 生成 CSV 文本（CRLF 换行，Excel 兼容）
export function buildTradeCsv(list: TradeRecord[]): string {
  const head = EXPORT_COLUMNS.map(c => c.label).join(',');
  const rows = list.map(r =>
    EXPORT_COLUMNS.map(c => {
      const raw = r[c.key];
      if (raw == null || raw === '') return '';
      if (typeof raw === 'number') {
        if (!Number.isFinite(raw)) return '';
        const n = c.pct ? raw * 100 : raw;
        return csvCell(Number(n.toFixed(6)));
      }
      return csvCell(raw);
    }).join(',')
  );
  // 前置 BOM，Excel 打开时才能正确识别 UTF-8 中文
  return '\uFEFF' + [head, ...rows].join('\r\n');
}

// 触发浏览器下载
export function downloadTradeCsv(list: TradeRecord[], filename: string): void {
  const blob = new Blob([buildTradeCsv(list)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
