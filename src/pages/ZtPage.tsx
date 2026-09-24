import ZtListPanel from '../components/ZtListPanel'
import ZtAnalysisPanel from '../components/ZtAnalysisPanel'
import './ZtPage.css'

/**
 * 首版涨停独立 Tab 页。
 * - 左侧：涨停股池列表 + 详情（ZtListPanel）
 * - 右侧：涨停分析（ZtAnalysisPanel：潮汐 / 行业 / 高度 / 排行 / 涨停次数）
 *
 * 数据源、刷新策略、文案与 ZtListPanel 完全一致。
 */
export default function ZtPage() {
  return (
    <div className="zt-page">
      <div className="zt-page-layout">
        <div className="zt-page-main">
          <ZtListPanel />
        </div>
        <aside className="zt-page-aside">
          <ZtAnalysisPanel />
        </aside>
      </div>
    </div>
  )
}