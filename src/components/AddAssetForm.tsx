import { useState } from 'react';
import { availableAShares, availableETFs } from '../data';
import './AddAssetForm.css';

interface Props {
  existingSymbols: string[];
  onAdd: (symbol: string) => void;
  onClose: () => void;
}

function AddAssetForm({ existingSymbols, onAdd, onClose }: Props) {
  const [search, setSearch] = useState('');

  const allAvailable = [
    ...availableAShares.map(a => ({ ...a, type: 'stock' as const, badge: 'A' })),
    ...availableETFs.map(a => ({ ...a, type: 'etf' as const, badge: 'E' })),
  ];

  const filtered = allAvailable.filter(
    a => !existingSymbols.includes(a.symbol) &&
      (a.name.includes(search) || a.symbol.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>添加资产跟踪</h2>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>

        <input
          className="search-input"
          type="text"
          placeholder="搜索股票或ETF名称/代码..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoFocus
        />

        <div className="asset-list">
          {filtered.map(a => (
            <div key={a.symbol} className="asset-option" onClick={() => onAdd(a.symbol)}>
              <div className="option-info">
                <span className={`type-badge ${a.type}`}>{a.badge}</span>
                <span className="option-name">{a.name}</span>
                <span className="option-symbol">{a.symbol.replace(/^(sh|sz)/, '')}</span>
              </div>
              <span className="option-add">+ 添加</span>
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="no-result">
              {search ? '没有匹配的资产' : '所有资产已跟踪'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default AddAssetForm;
