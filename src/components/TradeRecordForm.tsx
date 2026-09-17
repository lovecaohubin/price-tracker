import { useState } from 'react';
import { TradeRecord, TradeRecordField } from '../types';
import './TradeRecordForm.css';

interface FieldDef {
  key: TradeRecordField;
  label: string;
  unit: string;
  pct?: boolean;
}

const GROUPS: { title: string; fields: FieldDef[] }[] = [
  {
    title: '资金',
    fields: [
      { key: 'principal', label: '本金', unit: '元' },
      { key: 'leverage', label: '杠杆资金', unit: '元' },
      { key: 'totalAmount', label: '总金额', unit: '元' },
      { key: 'currentAmount', label: '当前金额', unit: '元' },
    ],
  },
  {
    title: '盈亏与仓位',
    fields: [
      { key: 'dayPnl', label: '当日盈亏', unit: '元' },
      { key: 'cumPnl', label: '累计盈亏', unit: '元' },
      { key: 'cumPnlRate', label: '累计盈亏比', unit: '%', pct: true },
      { key: 'positionRate', label: '仓位', unit: '%', pct: true },
    ],
  },
  {
    title: '盘面数据',
    fields: [
      { key: 'marketValue1', label: '市值1', unit: '元' },
      { key: 'marketValue2', label: '市值2', unit: '元' },
      { key: 'turnover', label: '成交量', unit: '' },
      { key: 'vsPrevDay', label: '较上一日', unit: '' },
      { key: 'changePct', label: '涨幅', unit: '%', pct: true },
      { key: 'mainCapital', label: '主力资金', unit: '' },
      { key: 'outflowRatio', label: '主流流出比', unit: '%', pct: true },
      { key: 'sseIndex', label: '上证指数', unit: '' },
    ],
  },
];

const ALL_FIELDS = GROUPS.flatMap(g => g.fields);
const PCT_KEYS = new Set(ALL_FIELDS.filter(f => f.pct).map(f => f.key));

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// 存储值 → 输入框文本（比率类放大为百分数，便于阅读录入）
function toInput(v: number | null | undefined, pct: boolean): string {
  if (v == null) return '';
  const n = pct ? v * 100 : v;
  return String(Math.round(n * 1e6) / 1e6);
}

// 输入框文本 → 存储值（百分数还原为小数）
function parseValue(s: string, pct: boolean): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return pct ? n / 100 : n;
}

// 新建记录时 totalAmount 字段的默认占位值，便于"本金+杠杆=0"的兜底
const DEFAULT_TOTAL_AMOUNT = 555000;

// 自动联动字段的展示说明（表单 helper 文案 + 「自动」徽章的依据）
const AUTO_HELPERS: Partial<Record<TradeRecordField, string>> = {
  dayPnl: '= 当日总金额 - 昨日总金额',
  cumPnl: '= 当前金额 - 总金额',
  cumPnlRate: '= 累计盈亏 / 总金额',
  positionRate: '= (市值1 + 市值2) / 当前金额',
  vsPrevDay: '= 当日成交量 - 昨日成交量',
  changePct: '= 较上一日 / 昨日成交量',
  outflowRatio: '= 主力资金 / 当日成交量',
};

interface Props {
  initial: TradeRecord | null;
  existingDates: string[];
  prevCurrentAmount: number | null;
  prevTotalAmount: number | null;
  prevTurnover: number | null;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (record: TradeRecord) => void;
}

function TradeRecordForm({
  initial, existingDates,
  prevCurrentAmount, prevTotalAmount, prevTurnover,
  saving, onCancel, onSubmit,
}: Props) {
  const [date, setDate] = useState(initial?.date ?? todayStr());
  const [plan, setPlan] = useState(initial?.plan ?? '');
  const [review, setReview] = useState(initial?.review ?? '');
  const [inputs, setInputs] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of ALL_FIELDS) {
      let v = initial?.[f.key] as number | null | undefined;
      // 新建记录时，totalAmount 默认填 555000，便于派生字段立即可用
      if (!initial && f.key === 'totalAmount' && v == null) {
        v = DEFAULT_TOTAL_AMOUNT;
      }
      init[f.key] = toInput(v, !!f.pct);
    }
    return init;
  });
  const [err, setErr] = useState('');

  // 全量重算所有派生字段。每次输入都跑一遍，依赖链简单稳定
  const recomputeDerived = (next: Record<string, string>) => {
    const v1 = parseValue(next.marketValue1 ?? '', false);
    const v2 = parseValue(next.marketValue2 ?? '', false);
    const cur = parseValue(next.currentAmount ?? '', false);
    const tot = parseValue(next.totalAmount ?? '', false);
    const turn = parseValue(next.turnover ?? '', false);

    // 累计盈亏 = 当前金额 - 总金额；累计盈亏比 = 累计盈亏 / 总金额
    if (cur != null && tot != null) {
      const cum = cur - tot;
      next.cumPnl = toInput(cum, false);
      if (tot !== 0) next.cumPnlRate = toInput(cum / tot, true);
    }
    // 仓位 = (市值1 + 市值2) / 当前金额（市值任一非空、当前金额非零才计算）
    const sumMv = (v1 != null || v2 != null) ? ((v1 ?? 0) + (v2 ?? 0)) : null;
    if (sumMv != null && cur != null && cur !== 0) {
      next.positionRate = toInput(sumMv / cur, true);
    }
    // 当日盈亏 = 当日总金额 - 昨日总金额（无昨日则保留原值）
    if (tot != null && prevTotalAmount != null) {
      next.dayPnl = toInput(tot - prevTotalAmount, false);
    }
    // 较上一日 = 当日成交量 - 昨日成交量（无昨日则保留原值）
    if (turn != null && prevTurnover != null) {
      next.vsPrevDay = toInput(turn - prevTurnover, false);
    }
    // 涨幅 = 较上一日 / 昨日成交量（昨日成交量缺失或为 0 则保留原值）
    const vpd = parseValue(next.vsPrevDay ?? '', false);
    if (vpd != null && prevTurnover != null && prevTurnover !== 0) {
      next.changePct = toInput(vpd / prevTurnover, true);
    }
    // 主流流出比 = 主力资金 / 当日成交量
    const m = parseValue(next.mainCapital ?? '', false);
    if (m != null && turn != null && turn !== 0) {
      next.outflowRatio = toInput(m / turn, true);
    }
  };

  const setField = (key: string, value: string) => {
    setInputs(prev => {
      const next = { ...prev, [key]: value };
      recomputeDerived(next);
      return next;
    });
  };

  // 按已录入的数据推算派生字段，减少手工计算
  const autoFill = () => {
    const next = { ...inputs };
    // 总金额：principal+leverage 之和；若二者皆空且未填，则默认 555000
    if (parseValue(next.totalAmount ?? '', false) == null) {
      const principal = parseValue(inputs.principal ?? '', false);
      const leverage = parseValue(inputs.leverage ?? '', false);
      const sum = (principal ?? 0) + (leverage ?? 0);
      next.totalAmount = toInput(sum > 0 ? sum : DEFAULT_TOTAL_AMOUNT, false);
    }
    recomputeDerived(next);
    setInputs(next);
  };

  const submit = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setErr('日期格式应为 YYYY-MM-DD');
      return;
    }
    const d = new Date(`${date}T00:00:00`);
    if (Number.isNaN(d.getTime())) {
      setErr('日期无效');
      return;
    }
    if (existingDates.includes(date)) {
      setErr('该日期已存在记录，请直接编辑那一条');
      return;
    }

    const nums: Partial<Record<TradeRecordField, number | null>> = {};
    for (const f of ALL_FIELDS) {
      nums[f.key] = parseValue(inputs[f.key] ?? '', !!f.pct);
    }

    onSubmit({
      id: initial?.id ?? '',
      seq: initial?.seq ?? 0,
      date,
      plan,
      review,
      ...(nums as Record<TradeRecordField, number | null>),
    } as TradeRecord);
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal trade-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{initial ? `编辑记录 · ${initial.date}` : '录入交易记录'}</h2>
          <button className="btn-close" onClick={onCancel}>✕</button>
        </div>

        <div className="trade-form-body">
          <div className="form-row">
            <label className="form-field">
              <span>日期 <i>*</i></span>
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
              />
            </label>
            <div className="form-hint">
              {prevCurrentAmount != null && <span>昨日当前金额：{prevCurrentAmount.toLocaleString('zh-CN')}</span>}
              {prevTotalAmount != null && <span>昨日总金额：{prevTotalAmount.toLocaleString('zh-CN')}</span>}
              {prevTurnover != null && <span>昨日成交量：{prevTurnover.toLocaleString('zh-CN')}</span>}
              <button className="btn-ghost" onClick={autoFill} type="button">
                自动计算派生字段
              </button>
            </div>
          </div>

          {GROUPS.map(g => (
            <div className="form-group" key={g.title}>
              <h4>{g.title}</h4>
              <div className="form-grid">
                {g.fields.map(f => {
                  const helper = AUTO_HELPERS[f.key];
                  const isAuto = !!helper;
                  return (
                    <label className="form-field" key={f.key}>
                      <span>
                        {f.label}
                        {f.unit && <em>{f.unit}</em>}
                        {isAuto && <em className="auto-tag">自动</em>}
                      </span>
                      <input
                        type="number"
                        step="any"
                        placeholder="—"
                        value={inputs[f.key] ?? ''}
                        onChange={e => setField(f.key, e.target.value)}
                        readOnly={isAuto}
                      />
                      {isAuto && <small className="form-helper">{helper}</small>}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="form-group">
            <h4>文字记录</h4>
            <label className="form-field block">
              <span>次日交易计划</span>
              <textarea
                rows={2}
                value={plan}
                onChange={e => setPlan(e.target.value)}
                placeholder="明日操作思路…"
              />
            </label>
            <label className="form-field block">
              <span>复盘</span>
              <textarea
                rows={2}
                value={review}
                onChange={e => setReview(e.target.value)}
                placeholder="今日复盘总结…"
              />
            </label>
          </div>

          {err && <div className="form-error">{err}</div>}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onCancel}>取消</button>
          <button className="btn-primary" onClick={submit} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default TradeRecordForm;
