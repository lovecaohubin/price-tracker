// 单资产持有建议模型
//
// 与 positionAdvice 的分工（两者互补，不要互相替代）：
//   positionAdvice 是「账户级」模型，输入大盘 + 账户盈亏 + 杠杆，回答「明天该拿多少仓位」；
//   holdAdvice 是「标的级」模型，输入该标的的位置 + 趋势 + 量价 + 大盘环境，回答「这只标的值不值得继续拿」。
//
// 设计要点：
//  1. 位置因子按「追高跟踪」的语义取值：越贴近 52 周新高说明承接资金越强（正分）。
//     但如果同时远离历史最高（距历史最高回撤 > 30%），那只是长期下跌趋势里的反弹，正分要打折。
//  2. 与 positionAdvice 一致，缺失因子按 0 贡献（不加不减），不做权重归一化，
//     否则「缺账户数据」会把剩余因子权重整体放大，同一标的会随数据齐全程度忽高忽低。
//  3. 大盘属于「环境因子」：缺失时不给惩罚性扣分，但置信度封顶为「中」——
//     脱离大盘环境的个股结论参考价值本来就要打折。

import { Asset } from '../types';
import { MarketSnapshot } from './market';

export type HoldLevel = 'strong' | 'hold' | 'watch' | 'reduce' | 'exit';

export type HoldConfidence = 'high' | 'medium' | 'low' | 'insufficient';

export interface HoldReason {
  /** 该因子对总分的净贡献（正数偏多、负数偏空），已按权重归一化 */
  delta: number;
  /** 人类可读的依据描述 */
  text: string;
}

export interface HoldAdvice {
  score: number;            // 0~100 综合评分，50 为中性
  level: HoldLevel;
  levelLabel: string;       // 强势持有 / 持有 / 观望 / 减仓 / 回避
  action: string;           // 结合支撑压力的持有动作建议
  reasons: HoldReason[];    // 计分依据（按权重从大到小）
  missing: string[];        // 缺失的关键数据
  coverage: number;         // 已有因子权重占总权重的比例（0~1）
  confidence: HoldConfidence;
  confidenceLabel: string;  // 高 / 中 / 偏低 / 不足
  /** 数据是否足以出具持有建议：为 false 时 score 与档位都不应被采信 */
  adviceAvailable: boolean;
  /** 距 52 周新高百分比（0 及以上表示已创新高），无法计算时为 null */
  gap52Week: number | null;
  /** 距历史最高百分比 */
  gapAllTimeHigh: number | null;
  /** 5 / 20 日均线（由近 30 个交易日收盘价计算，样本不足为 null） */
  ma5: number | null;
  ma20: number | null;
  /** 参考支撑：20 日线，缺失时退化为 5 日线 */
  support: number | null;
  /** 参考压力：52 周新高 */
  resistance: number | null;
}

/** 因子权重表，合计 1.00 */
const WEIGHTS = {
  position: 0.28,   // 价格位置（距 52 周新高 / 历史最高）
  trend: 0.24,      // 均线趋势（现价 vs 5 / 20 日线 + 近 30 日涨跌）
  momentum: 0.18,   // 当日量价配合
  volume: 0.12,     // 换手活跃度
  market: 0.18,     // 大盘环境
} as const;

type FactorKey = keyof typeof WEIGHTS;

const FACTOR_LABEL: Record<FactorKey, string> = {
  position: '价格位置',
  trend: '均线趋势',
  momentum: '量价配合',
  volume: '换手活跃度',
  market: '大盘环境',
};

/** 大盘环境因子：缺失时置信度封顶为「中」 */
const MARKET_KEY: FactorKey = 'market';

const ALL_KEYS = Object.keys(WEIGHTS) as FactorKey[];

/** 全部因子权重合计（覆盖率的分母） */
const TOTAL_WEIGHT = ALL_KEYS.reduce((s, k) => s + WEIGHTS[k], 0);

/**
 * 置信度阈值：按因子权重覆盖率分档。
 *  全部因子齐全 → 1.00（高）
 *  缺大盘环境 → 0.82（封顶为中）
 *  再缺量价配合 → 0.64（中）
 *  缺大盘 + 均线趋势 → 0.58（偏低）
 *  K 线拉不到（位置 + 趋势同时缺失）→ 0.48（不足，不出建议）
 *
 * 下限取 0.5 而非更低，是因为位置 + 趋势合计权重 0.52：
 * 没有个股自身的位置与趋势数据时，剩下的只有当日量价与大盘，
 * 那点信息不足以支撑「继续持有还是减仓」这种结论。
 */
const CONF_HIGH = 0.8;
const CONF_MEDIUM = 0.6;
const CONF_LOW = 0.5;

const CONFIDENCE_LABEL: Record<HoldConfidence, string> = {
  high: '高',
  medium: '中',
  low: '偏低',
  insufficient: '不足',
};

/** 置信度偏低时向中性（50 分）收缩的比例：只保留一半的方向性判断 */
const LOW_CONF_SHRINK = 0.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 比率 → 百分比文本（0.0123 → 1.23%） */
const fmtPct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;

/** 已是百分点 → 百分比文本（1.23 → 1.23%） */
const fmtPctPoints = (v: number, digits = 2) => `${Math.abs(v).toFixed(digits)}%`;

const fmtPrice = (v: number) =>
  v >= 1000
    ? v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : v >= 1
      ? v.toFixed(2)
      : v.toFixed(4);

/** 收盘价序列的 n 日均线；样本不足 n 根视为不可用 */
export function movingAverageOf(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  const sample = closes.slice(-n);
  return sample.reduce((a, b) => a + b, 0) / sample.length;
}

interface FactorDraft {
  key: FactorKey;
  raw: number | null;   // 归一化得分 -1 ~ 1，null 表示数据缺失
  text: string;
}

export function buildHoldAdvice(asset: Asset, market?: MarketSnapshot | null): HoldAdvice {
  const drafts: FactorDraft[] = [];
  const priceNow = asset.currentPrice;

  const closes = asset.priceHistory.map((p) => p.price).filter((v) => v > 0);
  const ma5 = movingAverageOf(closes, 5);
  const ma20 = movingAverageOf(closes, 20);

  // K 线拉取失败时 high52Week 会退化成「当日最高价」（见 aStockApi.fetchAssetData），
  // 位置因子在那时是假的，宁可判为缺失，也不能据此说「已突破 52 周新高」
  const hasKline = closes.length >= 2;
  const has52WeekHigh = hasKline && asset.high52Week > 0 && priceNow > 0;
  const gap52Week = has52WeekHigh ? (asset.high52Week - priceNow) / asset.high52Week : null;
  const gapAllTimeHigh =
    asset.allTimeHigh > 0 && priceNow > 0 ? (asset.allTimeHigh - priceNow) / asset.allTimeHigh : null;

  // ① 价格位置：越贴近 52 周新高越强；远离历史最高说明只是反弹，正分打折
  if (gap52Week != null) {
    let raw: number;
    if (gap52Week <= 0.005) raw = 1;
    else if (gap52Week <= 0.03) raw = 0.85;
    else if (gap52Week <= 0.08) raw = 0.55;
    else if (gap52Week <= 0.15) raw = 0.2;
    else if (gap52Week <= 0.3) raw = -0.25;
    else raw = -0.65;

    let tail = '';
    if (gapAllTimeHigh != null) {
      if (gapAllTimeHigh <= 0.005) {
        raw = clamp(raw + 0.15, -1, 1);
        tail = '，已创历史新高';
      } else if (gapAllTimeHigh > 0.3) {
        raw = clamp(raw - 0.3, -1, 1);
        tail = `，但距历史最高仍有 ${fmtPct(gapAllTimeHigh)}（长期趋势尚未修复）`;
      }
    }

    drafts.push({
      key: 'position',
      raw,
      text:
        (gap52Week <= 0
          ? `现价 ${fmtPrice(priceNow)} 已突破 52 周新高 ${fmtPrice(asset.high52Week)}`
          : `现价 ${fmtPrice(priceNow)}，距 52 周新高 ${fmtPrice(asset.high52Week)} 还差 ${fmtPct(gap52Week)}`) +
        tail,
    });
  } else {
    drafts.push({
      key: 'position',
      raw: null,
      text: priceNow > 0 ? '缺少日 K 数据（52 周新高会退化为当日最高，故不参与计分）' : '缺少现价 / 52 周新高',
    });
  }

  // ② 均线趋势：短期均线在长期均线上方为多头排列，叠加近 30 日累计涨跌
  if (ma5 != null && ma20 != null) {
    const above5 = priceNow >= ma5;
    const bull = ma5 >= ma20;
    let raw = above5 ? (bull ? 0.85 : 0.35) : bull ? -0.35 : -0.85;
    const r30 = closes.length >= 2 ? (closes[closes.length - 1] - closes[0]) / closes[0] : null;
    if (r30 != null) {
      if (r30 >= 0.1) raw += 0.15;
      else if (r30 <= -0.1) raw -= 0.15;
    }
    raw = clamp(raw, -1, 1);
    drafts.push({
      key: 'trend',
      raw,
      text:
        `现价 ${above5 ? '站上' : '跌破'} 5 日线 ${fmtPrice(ma5)}（20 日线 ${fmtPrice(ma20)}，` +
        `短均线在长均线${bull ? '上方' : '下方'}）` +
        (r30 != null ? `，近 30 个交易日${r30 >= 0 ? '涨' : '跌'} ${fmtPct(Math.abs(r30))}` : ''),
    });
  } else {
    drafts.push({ key: 'trend', raw: null, text: '缺少近 30 日走势（无法计算 5 / 20 日均线）' });
  }

  // ③ 量价配合：放量上涨健康，放量下跌多为出货，缩量影响减半
  if (asset.changePercent !== 0 || asset.turnoverRate > 0) {
    const chg = asset.changePercent;
    const hot = asset.turnoverRate >= 7;
    const cold = asset.turnoverRate < 3;
    let raw: number;
    let desc: string;
    if (chg === 0) {
      raw = 0;
      desc = '平盘';
    } else if (chg > 0) {
      if (hot) { raw = 1; desc = '放量上涨，量价配合良好'; }
      else if (cold) { raw = 0.3; desc = '缩量上涨，跟风资金有限'; }
      else { raw = 0.6; desc = '温和放量上涨'; }
    } else if (hot) { raw = -1; desc = '放量下跌，抛压明显'; }
    else if (cold) { raw = -0.3; desc = '缩量回调，抛压有限'; }
    else { raw = -0.6; desc = '下跌且量能未见萎缩'; }

    drafts.push({
      key: 'momentum',
      raw,
      text: `当日${chg >= 0 ? '涨' : '跌'} ${fmtPctPoints(chg)}、换手 ${asset.turnoverRate.toFixed(2)}%，${desc}`,
    });
  } else {
    drafts.push({ key: 'momentum', raw: null, text: '缺少当日涨跌幅 / 换手率' });
  }

  // ④ 换手活跃度：适度活跃说明有资金关注，过低无人问津，过高则分歧剧烈
  if (asset.turnoverRate > 0) {
    const t = asset.turnoverRate;
    let raw: number;
    let level: string;
    if (t >= 20) { raw = -0.8; level = '换手过热，分歧剧烈'; }
    else if (t >= 10) { raw = -0.2; level = '换手偏高'; }
    else if (t >= 3) { raw = 0.6; level = '换手活跃，资金关注度足'; }
    else if (t >= 1) { raw = -0.2; level = '换手偏低'; }
    else { raw = -0.5; level = '换手极低，流动性差'; }

    drafts.push({ key: 'volume', raw, text: `换手率 ${t.toFixed(2)}%，${level}` });
  } else {
    drafts.push({ key: 'volume', raw: null, text: '缺少换手率' });
  }

  // ⑤ 大盘环境：指数均线位置 + 当日涨跌，避免个股逆势被高估
  const sse = market?.sse;
  if (sse && sse.close > 0 && market?.ma5 != null && market.ma5 > 0) {
    const above5 = sse.close >= market.ma5;
    const ma20v = market.ma20;
    const bull = ma20v != null && ma20v > 0 ? market.ma5 >= ma20v : null;
    let raw = above5 ? (bull === false ? 0.3 : 0.8) : bull === true ? -0.4 : -0.8;
    if (sse.changePct != null) {
      if (sse.changePct >= 0.005) raw += 0.2;
      else if (sse.changePct <= -0.005) raw -= 0.2;
    }
    raw = clamp(raw, -1, 1);
    drafts.push({
      key: 'market',
      raw,
      text:
        `上证指数 ${sse.close.toFixed(2)}，${above5 ? '站上' : '跌破'} 5 日线 ${market.ma5.toFixed(2)}` +
        (ma20v != null ? `（20 日线 ${ma20v.toFixed(2)}，短均线在长均线${bull ? '上方' : '下方'}）` : '') +
        (sse.changePct != null ? `，当日${sse.changePct >= 0 ? '涨' : '跌'} ${fmtPct(Math.abs(sse.changePct), 2)}` : ''),
    });
  } else {
    drafts.push({ key: 'market', raw: null, text: '缺少大盘数据' });
  }

  // 总分 = 50 + Σ(权重 × 因子得分 × 50)，缺失因子按 0 贡献
  let rawScore = 50;
  const reasons: HoldReason[] = [];
  const active: FactorDraft[] = [];
  for (const d of drafts) {
    if (d.raw == null) continue;
    active.push(d);
    const contribution = WEIGHTS[d.key] * d.raw * 50;
    rawScore += contribution;
    reasons.push({ delta: Math.round(contribution), text: d.text });
  }

  const coverage = clamp(active.reduce((s, d) => s + WEIGHTS[d.key], 0) / TOTAL_WEIGHT, 0, 1);
  const missing = drafts.filter((d) => d.raw == null).map((d) => FACTOR_LABEL[d.key]);

  let confidence: HoldConfidence =
    coverage >= CONF_HIGH
      ? 'high'
      : coverage >= CONF_MEDIUM
        ? 'medium'
        : coverage >= CONF_LOW
          ? 'low'
          : 'insufficient';
  // 大盘是环境因子：不因缺失而扣分，但结论不能标成「高」置信度
  if (confidence === 'high' && missing.includes(FACTOR_LABEL[MARKET_KEY])) confidence = 'medium';

  const adviceAvailable = confidence !== 'insufficient';

  // 置信度偏低：只保留一半的方向性判断，避免用少数因子把结论推到「回避」或「强势持有」
  const adjusted = confidence === 'low' ? 50 + (rawScore - 50) * LOW_CONF_SHRINK : rawScore;
  const score = clamp(Math.round(adjusted), 0, 100);

  let level: HoldLevel;
  let levelLabel: string;
  if (score >= 76) { level = 'strong'; levelLabel = '强势持有'; }
  else if (score >= 60) { level = 'hold'; levelLabel = '持有'; }
  else if (score >= 44) { level = 'watch'; levelLabel = '观望'; }
  else if (score >= 30) { level = 'reduce'; levelLabel = '减仓'; }
  else { level = 'exit'; levelLabel = '回避'; }

  const support = ma20 ?? ma5 ?? null;
  const resistance = asset.high52Week > 0 ? asset.high52Week : null;
  const supportText = support != null ? `跌破 ${fmtPrice(support)}` : '跌破 20 日线';
  const resistText = resistance != null ? `放量突破 ${fmtPrice(resistance)}` : '放量突破 52 周新高';

  let action: string;
  if (!adviceAvailable) {
    action = `可用因子权重仅 ${Math.round(coverage * 100)}%（低于 ${Math.round(
      CONF_LOW * 100,
    )}% 不出建议），未给出持有建议；请先补齐：${missing.length ? missing.join('、') : '关键行情数据'}`;
  } else if (level === 'strong') {
    action = `趋势与量价共振，可继续持有；${supportText} 减半仓，${resistText} 后再加仓`;
  } else if (level === 'hold') {
    action = `可继续持有并等确认；${resistText} 后加仓，${supportText} 视为趋势转弱`;
  } else if (level === 'watch') {
    action = `多空信号混合，暂不加仓；${supportText} 减仓，站上 20 日线再考虑回补`;
  } else if (level === 'reduce') {
    action = `回撤或量价背离明显，建议逢反弹减仓；${supportText} 清出观望`;
  } else {
    action = `趋势与量能双弱，建议清仓回避；待重新站上 20 日线且量能恢复再纳入观察`;
  }

  reasons.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    score,
    level,
    levelLabel,
    action,
    reasons,
    missing,
    coverage,
    confidence,
    confidenceLabel: CONFIDENCE_LABEL[confidence],
    adviceAvailable,
    gap52Week,
    gapAllTimeHigh,
    ma5,
    ma20,
    support,
    resistance,
  };
}
