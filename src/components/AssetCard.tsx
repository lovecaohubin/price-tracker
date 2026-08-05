import { Asset } from '../types';
import './AssetCard.css';

function getTurnoverLevel(rate: number): string {
  if (rate >= 20) return 'hot';
  if (rate >= 15) return 'high';
  if (rate >= 7) return 'warn';
  if (rate >= 3) return 'mid';
  return '';
}

interface Props {
  asset: Asset;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function AssetCard({ asset, isSelected, onSelect, onDelete }: Props) {
  const safe52W = asset.high52Week || 1;
  const safeATH = asset.allTimeHigh || 1;
  const gap52W = ((safe52W - asset.currentPrice) / safe52W) * 100;
  const gapATH = ((safeATH - asset.currentPrice) / safeATH) * 100;
  const isNearHigh = gapATH <= 5;
  const isAtHigh = gapATH <= 0.5;

  const formatPrice = (p: number) => {
    if (p >= 1000) return p.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (p >= 1) return p.toFixed(2);
    return p.toFixed(4);
  };

  return (
    <div
      className={`asset-card ${isSelected ? 'selected' : ''} ${isAtHigh ? 'at-high' : ''} ${isNearHigh ? 'near-high' : ''}`}
      onClick={onSelect}
    >
      <div className="card-top">
        <div className="asset-info">
          <span className={`type-badge ${asset.type}`}>
            {asset.type === 'stock' ? 'A' : 'E'}
          </span>
          <div className="asset-name-row">
            <span className="asset-name">{asset.name}</span>
            <span className="asset-symbol">{asset.symbol}</span>
          </div>
        </div>
        <button
          className="btn-delete"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="删除"
        >✕</button>
      </div>

      <div className="card-price">
        <span className="current-price">{formatPrice(asset.currentPrice)}</span>
        <span className={`change-badge ${asset.changePercent >= 0 ? 'up' : 'down'}`}>
          {asset.changePercent >= 0 ? '↑' : '↓'} {Math.abs(asset.changePercent)}%
        </span>
        <span className={`turnover-badge ${getTurnoverLevel(asset.turnoverRate)}`}>换手 {asset.turnoverRate.toFixed(2)}%</span>
        {asset.prevTurnoverRate != null && asset.prevTurnoverRate !== asset.turnoverRate && (
          <span className={`turnover-delta ${asset.turnoverRate > asset.prevTurnoverRate ? 'up' : 'down'}`}>
            {asset.turnoverRate > asset.prevTurnoverRate ? '↑' : '↓'}
            {Math.abs(asset.turnoverRate - asset.prevTurnoverRate).toFixed(2)}%
          </span>
        )}
      </div>

      <div className="card-highs">
        <div className="high-one-row">
          <span className="high-item"><label>52周新高</label> {formatPrice(asset.high52Week)}</span>
          <span className="high-item"><label>历史最高</label> {formatPrice(asset.allTimeHigh)}</span>
        </div>
      </div>

      <div className="progress-section">
        <div className="progress-bar-bg">
          <div
            className={`progress-bar-fill ${isAtHigh ? 'full' : isNearHigh ? 'warn' : ''}`}
            style={{ width: `${Math.max(0, Math.min(100, (asset.currentPrice / safe52W) * 100))}%` }}
          />
        </div>
        <span className={`progress-text ${isNearHigh ? 'warn' : ''}`}>
          {isAtHigh ? '🚀 创历史新高！' : `距52周新高 ${gap52W.toFixed(1)}%`}
        </span>
      </div>
    </div>
  );
}

export default AssetCard;
