import { useState } from 'react';
import { availableAShares } from '../data';
import './AddAssetForm.css';

interface Props {
  existingSymbols: string[];
  onAdd: (symbol: string) => void;
  onClose: () => void;
}

function AddAssetForm({ existingSymbols, onAdd, onClose }: Props) {
  const [search, setSearch] = useState('');

  const filtered = availableAShares.filter(
    a => !existingSymbols.includes(a.symbol) &&
      (a.name.includes(search) || a.symbol.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>添加 A 股跟踪</h2>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>

        <input
          className="search-input"
          type="text"
          placeholder="搜索股票名称或代码..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoFocus
        />

        <div className="asset-list">
          {filtered.map(a => (
            <div key={a.symbol} className="asset-option" onClick={() => onAdd(a.symbol)}>
              <div className="option-info">
                <span className="type-badge stock">A</span>
                <span className="option-name">{a.name}</span>
                <span className="option-symbol">{a.symbol.replace(/^(sh|sz)/, '')}</span>
              </div>
              <span className="option-add">+ 添加</span>
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="no-result">
              {search ? '没有匹配的股票' : '所有股票已跟踪'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default AddAssetForm;
