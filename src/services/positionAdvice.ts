// 次日仓位建议模型（v2）
//
// 相对 v1 的变化：
//  1. 由「等权加减分」改为「权重加权」：新增因子不会把总分顶满，档位区分度更稳定；
//     数据缺失时按已有因子的权重归一化，避免缺一项就整体偏低。
//  2. 新增基准因子「主力资金均值」「成交量均值」：单日资金/量能容易被脉冲干扰，
//     与近 5 个交易日的均值比较才能区分「趋势性变化」与「偶发波动」。
//  3. 新增「指数位置」因子（收盘价相对 5 / 20 日均线 + 当日收盘位置），
//     避免下跌趋势中一根阳线就给出高仓位。
//
// 输入中的均值口径与录入字段一致：主力资金均值 = 前 N 个交易日的 mainCapital 均值，
// 成交量均值 = 前 N 个交易日的 turnover 均值（不含当日，这样「当日 vs 均值」才有比较意义）。
//
// 相对 v2 的变化（v3）：
//  1. 新增「置信度」：按已有因子的权重覆盖率分档，而不是数「缺了几项」——
//     缺「大盘趋势」和缺「杠杆资金」对结论的影响完全不同；
//  2. 覆盖率不足时不出具仓位建议（宁可没有建议，也不要给一个看起来精确的错答案）；
//  3. 覆盖率偏低时建议区间向中性收敛，避免用少数因子把仓位推到极端。

/** 均值窗口：近 5 个交易日 */
export const MEAN_WINDOW = 5;

export interface AdviceReason {
  /** 该因子对总分的净贡献（正数加仓、负数减仓），已按权重归一化 */
  delta: number;
  /** 人类可读的依据描述 */
  text: string;
}

export type AdviceLevel = 'attack' | 'bullish' | 'neutral' | 'bearish' | 'defensive';

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'insufficient';

/** 因子权重表：合计 1.00，其中市场类因子（用于回测）合计 0.75，账户类 0.25 */
const WEIGHTS = {
  trend: 0.2,         // 大盘趋势
  capital: 0.12,      // 主力资金强度（占成交量）
  capitalTrend: 0.11, // 主力资金 vs 近 N 日均值
  volumeMom: 0.12,    // 量能环比（较上一日）
  volumeLevel: 0.11,  // 量能水平 vs 近 N 日均值
  account: 0.15,      // 账户累计盈亏
  leverage: 0.1,      // 杠杆资金占比
  position: 0.09,     // 指数位置（均线）
} as const;

type FactorKey = keyof typeof WEIGHTS;

/** 只反映市场的因子：账户盈亏与杠杆属于「账户状态」，不参与模型有效性回测 */
const MARKET_KEYS: FactorKey[] = ['trend', 'capital', 'capitalTrend', 'volumeMom', 'volumeLevel', 'position'];

const ALL_KEYS = Object.keys(WEIGHTS) as FactorKey[];

/** 全部因子权重合计（覆盖率的分母） */
const TOTAL_WEIGHT = ALL_KEYS.reduce((s, k) => s + WEIGHTS[k], 0);

/** 市场侧因子权重合计（marketCoverage 的分母） */
const MARKET_WEIGHT = MARKET_KEYS.reduce((s, k) => s + WEIGHTS[k], 0);

/**
 * 置信度阈值：按因子权重覆盖率分档。
 * 阈值对应「缺什么」而非「缺几项」，例如：
 *  扣掉资本均值 + 量能均值 = 0.22 → 覆盖率 0.78（高）
 *  再扣掉大盘趋势 = 0.42 → 覆盖率 0.58（中）
 *  连账户数据都没有 = 0.67 → 覆盖率 0.33（不足，不出建议）
 */
const CONF_HIGH = 0.75;
const CONF_MEDIUM = 0.55;
const CONF_LOW = 0.35;

const CONFIDENCE_LABEL: Record<ConfidenceLevel, string> = {
  high: '高',
  medium: '中',
  low: '偏低',
  insufficient: '不足',
};

/** 覆盖不足时向中性区间收敛的锚点（30%~50% 与「中性」档位一致） */
const NEUTRAL_MIN = 0.3;
const NEUTRAL_MAX = 0.5;

/** 置信度偏低时向中性锚点收缩的比例：只保留一半的方向性判断 */
const LOW_CONF_SHRINK = 0.5;

const FACTOR_LABEL: Record<FactorKey, string> = {
  trend: '大盘趋势（上证指数）',
  capital: '主力资金强度',
  capitalTrend: '主力资金均值',
  volumeMom: '量能环比',
  volumeLevel: '成交量均值',
  account: '账户累计盈亏',
  leverage: '杠杆资金',
  position: '指数位置（均线）',
};

export interface PositionAdvice {
  score: number;              // 0~100 综合评分，50 为中性
  /** 仅市场类因子的评分，用于模型有效性验证（回测） */
  marketScore: number | null;
  level: AdviceLevel;
  levelLabel: string;         // 进攻 / 偏多 / 中性 / 偏空 / 防守
  minPosition: number;        // 建议仓位下限（0~1）
  maxPosition: number;        // 建议仓位上限（0~1）
  action: string;             // 结合当前仓位的次日动作建议
  reasons: AdviceReason[];    // 计分依据（按权重从大到小）
  missing: string[];          // 缺失的关键数据
  /** 已有因子权重占总权重的比例（0~1），1 表示所有因子都有数据 */
  coverage: number;
  /** 市场侧因子（大盘 / 资金 / 量能 / 均线）的覆盖率（0~1） */
  marketCoverage: number;
  confidence: ConfidenceLevel;
  confidenceLabel: string;    // 高 / 中 / 偏低 / 不足
  /** 数据是否足以出具仓位区间：为 false 时 score 与区间都不应被采信 */
  adviceAvailable: boolean;
}

export interface AdviceInput {
  sseIndex: number | null;      // 上证指数
  prevSseIndex: number | null;  // 上一交易日上证指数
  mainCapital: number | null;   // 主力资金（正为净流入，亿元）
  outflowRatio: number | null;  // 主力资金 / 成交量
  changePct: number | null;     // 量能变化率（较上一日 / 昨日成交量）
  dayPnl: number | null;        // 当日盈亏
  cumPnlRate: number | null;    // 累计盈亏比
  positionRate: number | null;  // 当前仓位
  principal: number | null;     // 本金
  leverage: number | null;      // 杠杆资金
  /** —— 以下为 v2 新增 —— */
  turnover: number | null;         // 当日成交量（成交额，与均值同口径）
  turnoverAvg: number | null;      // 近 N 个交易日成交量均值（不含当日）
  mainCapitalAvg: number | null;   // 近 N 个交易日主力资金均值（不含当日）
  avgSample: number;               // 均值样本天数
  sseMa5: number | null;           // 上证 5 日均线
  sseMa20: number | null;          // 上证 20 日均线
  sseClosePosition: number | null; // 收盘在当日最高/最低之间的位置 0~1（尾盘强弱）
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const fmtPct = (v: number, digits = 2) => `${(v * 100).toFixed(digits)}%`;

const fmtNum = (v: number, digits = 0) =>
  v.toLocaleString('zh-CN', { maximumFractionDigits: digits });

/** 取最近 window 条记录中非空数值的均值（不足 2 条样本视为不可用） */
export function meanOf(values: (number | null | undefined)[], window = MEAN_WINDOW) {
  const sample = values.slice(-window).filter((v): v is number => v != null && Number.isFinite(v));
  if (sample.length < 2) return { avg: null as number | null, sample: sample.length };
  return { avg: sample.reduce((a, b) => a + b, 0) / sample.length, sample: sample.length };
}

interface FactorDraft {
  key: FactorKey;
  raw: number | null;   // 归一化得分 -1 ~ 1，null 表示数据缺失
  text: string;
}

export function buildPositionAdvice(input: AdviceInput): PositionAdvice {
  const {
    sseIndex, prevSseIndex, mainCapital, outflowRatio,
    changePct, cumPnlRate, positionRate, principal, leverage,
    turnover, turnoverAvg, mainCapitalAvg, avgSample,
    sseMa5, sseMa20, sseClosePosition,
  } = input;

  const drafts: FactorDraft[] = [];

  // ① 大盘趋势：涨跌幅度分档（>1% 记满分），穿越整百 / 整千关口再加权
  let trendDir: boolean | null = null;
  {
    if (sseIndex != null && prevSseIndex != null && prevSseIndex !== 0) {
      const diff = sseIndex - prevSseIndex;
      const diffPct = diff / prevSseIndex;
      const crossed =
        Math.floor(sseIndex / 100) !== Math.floor(prevSseIndex / 100) ||
        Math.floor(sseIndex / 1000) !== Math.floor(prevSseIndex / 1000);
      const mag = Math.abs(diffPct);
      const base = mag >= 0.01 ? 1 : mag >= 0.005 ? 0.75 : mag >= 0.002 ? 0.5 : 0.25;
      trendDir = diff > 0 ? true : diff < 0 ? false : null;
      drafts.push({
        key: 'trend',
        raw: trendDir == null ? 0 : (trendDir ? 1 : -1) * Math.min(1, base + (crossed ? 0.25 : 0)),
        text:
          trendDir == null
            ? `上证指数 ${sseIndex.toFixed(2)}，与上一交易日持平`
            : `上证指数 ${sseIndex.toFixed(2)}，较上一交易日${trendDir ? '上涨' : '下跌'} ${diffPct > 0 ? fmtPct(diffPct) : fmtPct(mag)}${
                crossed ? '，穿越整百/整千关口' : '，未越整数关口'
              }`,
      });
    } else {
      drafts.push({ key: 'trend', raw: null, text: '缺少上证指数（含上一交易日）' });
    }
  }

  // ② 主力资金强度：以「主力资金 / 成交量」衡量流入流出的力度
  if (outflowRatio != null && outflowRatio !== 0) {
    const mag = Math.abs(outflowRatio);
    const base = mag >= 0.03 ? 1 : mag >= 0.015 ? 0.7 : mag >= 0.005 ? 0.4 : 0.15;
    drafts.push({
      key: 'capital',
      raw: (outflowRatio > 0 ? 1 : -1) * base,
      text: `主力资金净${outflowRatio > 0 ? '流入' : '流出'} ${
        mainCapital != null ? `${fmtNum(Math.abs(mainCapital))} ` : ''
      }，占成交量 ${fmtPct(mag)}`,
    });
  } else {
    drafts.push({ key: 'capital', raw: null, text: '缺少主力资金 / 成交量' });
  }

  // ③ 主力资金 vs 近 N 日均值：区分「趋势性流入」与「单日脉冲」
  if (mainCapital != null && mainCapitalAvg != null) {
    const diff = mainCapital - mainCapitalAvg;
    let raw: number;
    let desc: string;
    if (mainCapital > 0 && mainCapitalAvg > 0) {
      raw = diff > 0 ? 1 : 0.5;
      desc = diff > 0 ? '资金持续流入且力度加大' : '资金仍在流入但力度减弱';
    } else if (mainCapital < 0 && mainCapitalAvg < 0) {
      raw = diff < 0 ? -1 : -0.45;
      desc = diff < 0 ? '资金持续流出且力度加大' : '资金仍在流出但流出收窄';
    } else if (mainCapital > 0) {
      raw = 0.6;
      desc = '资金由净流出转为净流入';
    } else {
      raw = -0.7;
      desc = '资金由净流入转为净流出';
    }
    drafts.push({
      key: 'capitalTrend',
      raw,
      text: `主力资金 ${fmtNum(mainCapital)}，近 ${avgSample} 日均值 ${fmtNum(mainCapitalAvg)}，${desc}`,
    });
  } else {
    drafts.push({ key: 'capitalTrend', raw: null, text: '缺少主力资金均值（历史样本不足）' });
  }

  // ④ 量能环比：放量顺向为健康，放量逆向多为出货；缩量影响减半
  if (changePct != null && changePct !== 0 && trendDir != null) {
    const mag = Math.abs(changePct);
    const base = mag >= 0.15 ? 1 : mag >= 0.08 ? 0.75 : mag >= 0.03 ? 0.5 : 0.2;
    const raw = changePct > 0 ? (trendDir ? base : -base) : (trendDir ? 1 : -1) * base * 0.35;
    drafts.push({
      key: 'volumeMom',
      raw,
      text: `量能较上一交易日${changePct > 0 ? '放大' : '缩小'} ${fmtPct(mag)}，${trendDir ? '指数向上' : '指数向下'}`,
    });
  } else {
    drafts.push({
      key: 'volumeMom',
      raw: null,
      text: changePct == null || changePct === 0 ? '缺少量能变化（较上一日）' : '缺少可判断方向的大盘涨跌',
    });
  }

  // ⑤ 量能水平 vs 近 N 日均量：天量需方向配合，地量多为观望
  if (turnover != null && turnoverAvg != null && turnoverAvg > 0) {
    const ratio = turnover / turnoverAvg;
    const dir = trendDir;
    let raw: number;
    let level: string;
    if (ratio >= 1.5) {
      raw = dir === false ? -1 : 1;
      level = '天量';
    } else if (ratio >= 1.2) {
      raw = dir === false ? -0.7 : 0.7;
      level = '明显放量';
    } else if (ratio >= 0.8) {
      raw = 0;
      level = '量能正常';
    } else if (ratio >= 0.6) {
      raw = dir === false ? 0.15 : -0.35;
      level = '缩量';
    } else {
      raw = dir === false ? 0.25 : -0.5;
      level = '地量';
    }
    drafts.push({
      key: 'volumeLevel',
      raw,
      text: `成交量 ${fmtNum(turnover)}，为近 ${avgSample} 日均量 ${fmtNum(turnoverAvg)} 的 ${ratio.toFixed(2)} 倍（${level}）`,
    });
  } else {
    drafts.push({ key: 'volumeLevel', raw: null, text: '缺少成交量均值（历史样本不足）' });
  }

  // ⑥ 账户盈亏：累计盈亏比决定账户自身的加仓空间（±15% 记满分）
  if (cumPnlRate != null) {
    drafts.push({
      key: 'account',
      raw: clamp(cumPnlRate / 0.15, -1, 1),
      text: `账户累计盈亏 ${fmtPct(cumPnlRate)}`,
    });
  } else {
    drafts.push({ key: 'account', raw: null, text: '缺少累计盈亏比' });
  }

  // ⑦ 杠杆资金：杠杆占比越高，建议仓位越保守
  const ownFund = (principal ?? 0) + (leverage ?? 0);
  if (leverage != null && leverage > 0 && ownFund > 0) {
    const ratio = leverage / ownFund;
    drafts.push({
      key: 'leverage',
      raw: -(ratio > 0.6 ? 1 : ratio > 0.3 ? 0.6 : 0.25),
      text: `杠杆资金占用资金 ${fmtPct(ratio)}`,
    });
  } else if (principal != null && principal > 0) {
    // 填了本金、没填杠杆 → 才是「确实没有杠杆」
    drafts.push({ key: 'leverage', raw: 0, text: '未使用杠杆资金' });
  } else {
    drafts.push({ key: 'leverage', raw: null, text: '缺少本金 / 杠杆资金' });
  }

  // ⑧ 指数位置：均线多空排列 + 当日收盘位置（尾盘强弱）
  if (sseIndex != null && sseMa5 != null && sseMa5 > 0) {
    const aboveMa5 = sseIndex >= sseMa5;
    const maUp = sseMa20 != null && sseMa20 > 0 ? sseMa5 >= sseMa20 : null;
    let raw = aboveMa5 ? (maUp === true ? 0.8 : 0.3) : maUp === false ? -0.8 : -0.5;
    const tail = sseClosePosition == null ? 0 : sseClosePosition >= 0.7 ? 0.15 : sseClosePosition <= 0.3 ? -0.15 : 0;
    raw = clamp(raw + tail, -1, 1);
    drafts.push({
      key: 'position',
      raw,
      text: `收盘 ${sseIndex.toFixed(2)} ${aboveMa5 ? '站上' : '跌破'} 5 日线 ${sseMa5.toFixed(2)}${
        sseMa20 != null
          ? `（20 日线 ${sseMa20.toFixed(2)}，短均线${maUp ? '在' : '仍在'}长均线${maUp ? '上方' : '下方'}）`
          : ''
      }${tail > 0 ? '，尾盘收于当日高位' : tail < 0 ? '，尾盘收于当日低位' : ''}`,
    });
  } else {
    drafts.push({ key: 'position', raw: null, text: '缺少指数均线（未获取大盘数据）' });
  }

  // 总分 = 50 + Σ(权重 × 因子得分 × 50)。
  // 缺失因子按 0 贡献（不加不减），不做权重归一化——否则「缺账户数据」会把市场因子的
  // 权重整体放大，让同一交易日出现「表格 71 分、弹窗 78 分」这种不一致。
  let score = 50;
  const reasons: AdviceReason[] = [];
  const active: FactorDraft[] = [];
  for (const d of drafts) {
    if (d.raw == null) continue;
    active.push(d);
    const contribution = WEIGHTS[d.key] * d.raw * 50;
    score += contribution;
    reasons.push({ delta: Math.round(contribution), text: d.text });
  }

  // 置信度：按「已有因子的权重覆盖率」衡量。缺「大盘趋势」（0.20）与缺「杠杆资金」（0.10）
  // 对结论的影响完全不同，所以不能用「缺几项」这种计数口径。
  const coverage = clamp(active.reduce((s, d) => s + WEIGHTS[d.key], 0) / TOTAL_WEIGHT, 0, 1);
  const missing = drafts.filter((d) => d.raw == null).map((d) => FACTOR_LABEL[d.key]);
  const confidence: ConfidenceLevel =
    coverage >= CONF_HIGH
      ? 'high'
      : coverage >= CONF_MEDIUM
        ? 'medium'
        : coverage >= CONF_LOW
          ? 'low'
          : 'insufficient';
  // 覆盖率不足时不背书任何方向性结论：此时分数与区间都不应被采信
  const adviceAvailable = confidence !== 'insufficient';

  const marketActive = active.filter((d) => MARKET_KEYS.includes(d.key));
  const marketWeight = marketActive.reduce((s, d) => s + WEIGHTS[d.key], 0);
  const marketCoverage = clamp(marketWeight / MARKET_WEIGHT, 0, 1);
  const marketScore = marketWeight
    ? clamp(
        Math.round(
          50 + (marketActive.reduce((s, d) => s + WEIGHTS[d.key] * (d.raw as number), 0) / marketWeight) * 50,
        ),
        0,
        100,
      )
    : null;

  const finalScore = clamp(Math.round(score), 0, 100);

  let level: AdviceLevel;
  let levelLabel: string;
  let minPosition: number;
  let maxPosition: number;
  if (finalScore >= 78) {
    level = 'attack'; levelLabel = '进攻'; minPosition = 0.7; maxPosition = 0.9;
  } else if (finalScore >= 62) {
    level = 'bullish'; levelLabel = '偏多'; minPosition = 0.5; maxPosition = 0.7;
  } else if (finalScore >= 46) {
    level = 'neutral'; levelLabel = '中性'; minPosition = 0.3; maxPosition = 0.5;
  } else if (finalScore >= 33) {
    level = 'bearish'; levelLabel = '偏空'; minPosition = 0.15; maxPosition = 0.3;
  } else {
    level = 'defensive'; levelLabel = '防守'; minPosition = 0; maxPosition = 0.15;
  }

  // 置信度偏低：只保留一半的方向性判断，剩余部分回归中性。
  // 宁可少押注，也不要让「缺一半因子」的结论把仓位推到 0% 或 90%。
  if (confidence === 'low') {
    minPosition += (NEUTRAL_MIN - minPosition) * LOW_CONF_SHRINK;
    maxPosition += (NEUTRAL_MAX - maxPosition) * LOW_CONF_SHRINK;
  }

  const rangeText = `${Math.round(minPosition * 100)}%~${Math.round(maxPosition * 100)}%`;
  let action: string;
  if (!adviceAvailable) {
    action = `可用因子权重仅 ${Math.round(coverage * 100)}%（低于 ${Math.round(
      CONF_LOW * 100,
    )}% 不予建议），未出具仓位区间；请先补齐：${missing.length ? missing.join('、') : '关键行情数据'}`;
  } else if (positionRate == null) {
    action = `次日建议仓位 ${rangeText}（录入市值1 / 市值2 后可对比当前仓位）`;
  } else if (positionRate > maxPosition + 0.1) {
    action = `当前仓位 ${fmtPct(positionRate, 1)} 高于建议上限，次日建议减仓至 ${rangeText}`;
  } else if (positionRate < minPosition - 0.1) {
    action = `当前仓位 ${fmtPct(positionRate, 1)} 低于建议下限，次日可择机加仓至 ${rangeText}`;
  } else {
    action = `当前仓位 ${fmtPct(positionRate, 1)} 落在建议区间内，次日维持 ${rangeText} 附近`;
  }

  // 依据按贡献排序，贡献为 0 的（如量能正常）保序跟随，便于阅读
  reasons.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    score: finalScore,
    marketScore,
    level,
    levelLabel,
    minPosition,
    maxPosition,
    action,
    reasons,
    missing,
    coverage,
    marketCoverage,
    confidence,
    confidenceLabel: CONFIDENCE_LABEL[confidence],
    adviceAvailable,
  };
}
