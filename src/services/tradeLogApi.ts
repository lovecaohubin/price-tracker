import { TradeRecord } from '../types';

const API = '/api/tradelog';

// 拉取全部交易记录（按日期升序返回）
export async function fetchTradeRecords(): Promise<TradeRecord[]> {
  const resp = await fetch(API, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`加载交易记录失败：HTTP ${resp.status}`);
  const data = await resp.json();
  if (!Array.isArray(data)) return [];
  return (data as TradeRecord[]).slice().sort((a, b) => a.date.localeCompare(b.date));
}

// 覆盖保存全部交易记录（页面录入后落盘到服务端 JSON）
export async function saveTradeRecords(records: TradeRecord[]): Promise<void> {
  const payload = records.slice().sort((a, b) => a.date.localeCompare(b.date));
  const resp = await fetch(API, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const err = await resp.json();
      if (err?.error) detail = err.error;
    } catch { /* 忽略解析失败 */ }
    throw new Error(`保存失败：${detail}`);
  }
}
