import { Asset } from '../types';
import './AssetCard.css';

interface Props {
  asset: Asset;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function AssetCard({ asset, isSelected, onSelect, onDelete }: Props) {
  const highGap = ((asset.high52Week - asset.currentPrice) / asset.high52Week * 100);
  const isNearHigh = highGap <= 5;
  const isAtHigh = highGap <= 0.5;

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
            {asset.type === 'stock' ? '股' : '币'}
          </span>
          <div>
            <h3 className="asset-name">{asset.name}</h3>
            <span className="asset-symbol">{asset.symbol}</span>
          </div>
        </div>
        <button
          className="btn-delete"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="删除"
        >
          ✕
        </button>
      </div>

      <div className="card-price">
        <span className="current-price">{formatPrice(asset.currentPrice)}</span>
        <span className={`change-badge ${asset.changePercent >= 0 ? 'up' : 'down'}`}>
          {asset.changePercent >= 0 ? '↑' : '↓'} {Math.abs(asset.changePercent)}%
        </span>
      </div>

      <div className="card-highs">
        <div className="high-row">
          <span className="high-label">52周新高</span>
          <span className="high-value">{formatPrice(asset.high52Week)}</span>
        </div>
        <div className="high-row">
          <span className="high-label">历史最高</span>
          <span className="high-value">{formatPrice(asset.allTimeHigh)}</span>
        </div>
      </div>

      {/* 距离新高进度条 */}
      <div className="progress-section">
        <div className="progress-bar-bg">
          <div
            className={`progress-bar-fill ${isAtHigh ? 'full' : isNearHigh ? 'warn' : ''}`}
            style={{ width: `${Math.min(100, (asset.currentPrice / asset.high52Week) * 100)}%` }}
          />
        </div>
        <span className={`progress-text ${isNearHigh ? 'warn' : ''}`}>
          {isAtHigh ? '🚀 创历史新高！' : `距52周新高 ${highGap.toFixed(1)}%`}
        </span>
      </div>
    </div>
  );
}

export default AssetCard;
