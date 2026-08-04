import { useState } from 'react';
import { availableAssets } from '../data';
import './AddAssetForm.css';

interface Props {
  existingSymbols: string[];
  onAdd: (symbol: string) => void;
  onClose: () => void;
}

function AddAssetForm({ existingSymbols, onAdd, onClose }: Props) {
  const [search, setSearch] = useState('');

  const filtered = availableAssets.filter(
    a => !existingSymbols.includes(a.symbol) &&
      (a.name.includes(search) || a.symbol.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>添加跟踪资产</h2>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>

        <input
          className="search-input"
          type="text"
          placeholder="搜索资产名称或代码..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoFocus
        />

        <div className="asset-list">
          {filtered.map(a => (
            <div key={a.symbol} className="asset-option" onClick={() => onAdd(a.symbol)}>
              <div className="option-info">
                <span className={`type-badge ${a.type}`}>
                  {a.type === 'stock' ? '股' : '币'}
                </span>
                <span className="option-name">{a.name}</span>
                <span className="option-symbol">{a.symbol}</span>
              </div>
              <span className="option-add">+ 添加</span>
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="no-result">
              {search ? '没有匹配的资产' : '所有资产已添加'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default AddAssetForm;
