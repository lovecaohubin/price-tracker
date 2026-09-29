import { useMemo, useState } from 'react';
import './AddAssetForm.css';

interface Props {
  existingSymbols: string[];
  /** symbol 为带市场前缀的完整代码（如 sh603248）；name 为可选自定义名称 */
  onAdd: (symbol: string, name?: string) => void;
  onClose: () => void;
}

/** 根据 6 位代码推断市场前缀（沪 sh / 深 sz / 京 bj） */
function inferMarket(code: string): string | null {
  if (!/^\d{6}$/.test(code)) return null;
  if (/^6\d{5}$/.test(code)) return 'sh'; // 沪市主板 60xxxx / 科创板 688xxx
  if (/^(0|3)\d{5}$/.test(code)) return 'sz'; // 深市主板 000/001/002/003、创业板 300/301
  if (/^5\d{5}$/.test(code)) return 'sh'; // 沪市 ETF/基金 51xxxx 56xxxx 58xxxx
  if (/^1\d{5}$/.test(code)) return 'sz'; // 深市 ETF/基金 15xxxx 16xxxx
  if (/^(4|8)\d{5}$/.test(code)) return 'bj'; // 北交所 4xxxxx / 8xxxxx
  if (/^920\d{3}$/.test(code)) return 'bj'; // 北交所 920xxx
  return null;
}

function AddAssetForm({ existingSymbols, onAdd, onClose }: Props) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const trimmed = code.trim();
  // 自动拼出带市场前缀的完整代码，让用户确认推断是否正确
  const fullSymbol = useMemo(() => {
    const market = inferMarket(trimmed);
    return market ? `${market}${trimmed}` : null;
  }, [trimmed]);

  const isDuplicate = fullSymbol ? existingSymbols.includes(fullSymbol) : false;

  const handleSubmit = () => {
    if (!trimmed) {
      setError('请输入 6 位股票代码');
      return;
    }
    if (!/^\d{6}$/.test(trimmed)) {
      setError('代码必须是 6 位数字，例如 603248');
      return;
    }
    if (!fullSymbol) {
      setError('无法识别该代码所属市场（沪 6/5、深 0/3/1、京 4/8/920）');
      return;
    }
    if (isDuplicate) {
      setError('该股票已在跟踪列表中');
      return;
    }
    onAdd(fullSymbol, name.trim() || undefined);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>添加资产跟踪</h2>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>

        <div className="add-form-body">
          <label className="add-field">
            <span className="add-label">
              股票代码 <em className="add-required">必填</em>
            </span>
            <input
              className="add-input"
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="例如 603248"
              value={code}
              onChange={e => {
                setCode(e.target.value.replace(/\D/g, ''));
                setError('');
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSubmit();
              }}
              autoFocus
            />
            <span className="add-hint">
              {fullSymbol
                ? <>识别为 <strong>{fullSymbol.toUpperCase()}</strong></>
                : '支持沪深 A 股、ETF、北交所（6 位数字）'}
            </span>
          </label>

          <label className="add-field">
            <span className="add-label">
              自定义名称 <em className="add-optional">选填</em>
            </span>
            <input
              className="add-input"
              type="text"
              maxLength={20}
              placeholder="留空则自动取行情返回的名称"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSubmit();
              }}
            />
          </label>

          {error && <p className="add-error">{error}</p>}

          <div className="add-actions">
            <button className="btn-cancel" onClick={onClose}>取消</button>
            <button
              className="btn-confirm"
              onClick={handleSubmit}
              disabled={!fullSymbol || isDuplicate}
            >
              {isDuplicate ? '已在跟踪列表' : '添加'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AddAssetForm;
