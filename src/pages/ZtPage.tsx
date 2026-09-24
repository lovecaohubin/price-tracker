import ZtListPanel from '../components/ZtListPanel'
import './ZtPage.css'

/**
 * 首版涨停独立 Tab 页。
 * 与「资产股票分析」平级，常驻右侧面板挪出来作为独立导航板块。
 * 数据源、刷新策略、文案与 ZtListPanel 完全一致。
 */
export default function ZtPage() {
  return (
    <div className="zt-page">
      <ZtListPanel />
    </div>
  )
}