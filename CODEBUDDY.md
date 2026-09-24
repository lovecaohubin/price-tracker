# A股资产追高跟踪 (A-Share Price Tracker)

## 项目概述
一个用于跟踪股票和加密货币价格新高的 Web 应用，帮助用户实时掌握资产是否接近或突破历史高点。

## 技术栈
- **前端框架**: React 18 + TypeScript
- **构建工具**: Vite 5
- **图表库**: Recharts 2
- **样式**: 纯 CSS（无第三方 UI 库）

## 项目结构
```
src/
├── main.tsx              # 入口文件
├── App.tsx               # 主应用组件（状态管理、筛选、排序）
├── App.css               # 主应用样式
├── index.css             # 全局样式
├── types.ts              # TypeScript 类型定义
├── data.ts               # 模拟数据和数据生成逻辑
├── vite-env.d.ts         # Vite 类型声明
└── components/
    ├── Header.tsx              # 顶部导航栏
    ├── AssetCard.tsx           # 资产卡片（价格、新高信息、进度条）
    ├── AddAssetForm.tsx        # 添加资产弹窗
    ├── PriceChart.tsx          # 价格走势折线图
    ├── HoldAdviceBacktest.tsx  # 持有建议的逐日滚动回测
    ├── ZtListPanel.tsx         # 首版涨停模块（独立 Tab）
    └── *.css                   # 对应组件的样式文件
server/
├── stockAnalysis.ts            # 股票分析（vite 插件）+ /api/stockanalysis
└── zt.ts                       # 首版涨停（vite 插件）+ /api/zt
```

## 核心功能
1. **资产仪表盘**: 卡片式展示所有跟踪资产
2. **新高追踪**: 实时显示当前价格与52周新高/历史最高的差距
3. **进度条可视化**: 直观展示价格距新高的百分比
4. **分类筛选**: 按股票/加密货币切换视图
5. **添加/删除资产**: 从可选列表中添加新资产或移除已有资产
6. **价格走势图**: 点击资产卡片查看近30天价格折线图
7. **按需股票分析按钮**: 资产跟踪页每只 A 股卡片右上角「股票分析」按钮（hover 显示），点击弹出模态框按需生成该股的「今日行情底色」「资金流向」两块数据，1-3 秒响应，不走 15:01 自动落盘。弹窗含数据源 / 口径标注（`components/SingleStockAnalysisModal.tsx` + `services/stockAnalysisApi.fetchSingleStockAnalysis` + `server/stockAnalysis.fetchSingleStock` + 路由 `GET /api/stockanalysis/single?code=`）。
8. **持有建议**: 每张资产卡片给出「强势持有 / 持有 / 观望 / 减仓 / 回避」档位与一句话动作（`services/holdAdvice.ts`）
9. **持有建议的模型验证**: 资产跟踪页底部可展开的逐日滚动回测面板，检验档位是否真的对应更好的后续表现（`components/HoldAdviceBacktest.tsx`）
10. **首版涨停**: 导航栏独立 Tab（资产股票分析之后），按涨幅排序的全市场涨停股池，本地判定首板/连板，列表显示价格 / 行业 / 成交量 / 主力资金；点击展开龙虎榜 / 资金流 / 两融 / 大宗交易等详情。Tab 内双栏：左侧涨停股池 + 详情，右侧涨停分析面板（潮汐指数 / 行业统计 / 涨停高度 / 个股排行 / 涨停次数）（`pages/ZtPage.tsx` + `components/ZtListPanel.tsx` + `components/ZtAnalysisPanel.tsx`）

## 建议模型
两个互补模型，都不预测涨跌，只做强弱与风险刻度：
- `services/positionAdvice.ts`：账户级「次日仓位区间」，输入大盘 + 账户盈亏 + 杠杆，在「数据分析」表格逐行展示并回测。
- `services/holdAdvice.ts`：标的级「持有建议」，输入标的的价格位置（距 52 周新高 / 历史最高）、均线趋势、量价与换手、大盘环境；按因子权重覆盖率给出置信度，覆盖不足时不出建议。
- `services/holdAdviceBacktest.ts`：持有建议的 point-in-time 验证。第 t 天只用截至当天的数据构造 Asset 快照打分，再看之后 1/3/5 个交易日的真实涨跌；输出各档位/五分位统计、相关系数与单调性判定。纯计算部分为 `computeHoldBacktest()`，可离线复算。

## 股票分析模块（每日 15:01 自动生成）
对跟踪列表里的全部标的生成收盘分析报告，数据源为东财公开接口（均实测可用）：
- `server/stockAnalysis.ts`：核心服务端（vite 插件）。抓取行情快照/估值（ulist）、当日资金流（主力/超大/大/中/小单+主力净占比，fflow）、龙虎榜及全量席位明细（含外资/机构专用识别 + RISE_PROBABILITY_3DAY 3 日胜率 + 近 10 次上榜历史，RPT_DAILYBILLBOARD_DETAILSNEW 等）、融资融券（T+1 披露，RPTA_WEB_RZRQ_GGMX）、大宗交易（RPT_DATA_BLOCKTRADE）、十大流通股东（RPT_F10_EH_FREEHOLDERS），并由日 K 本地计算 RSI/KDJ/BOLL/MA。
- 解读要点为规则引擎生成（资金派发/吸筹结构、龙虎榜与主力口径背离、两融连续净偿还、QFII 增减、超买超卖等），不做涨跌预测，报告尾部带免责声明。
- 定时执行：dev server 常驻进程内每 30 秒检查，交易日 15:01–15:10 窗口触发（日K落库延迟自动重试），`lastRunAt` 时间戳判重；跟踪列表由前端每次变更时 `PUT /api/stockanalysis` 上报。
- 报告落盘 `data/stockAnalysis.json`（保留最近 10 个交易日），前端「资产股票分析」Tab（`src/pages/StockAnalysis.tsx`）按日期查看，支持「立即生成」手动触发。
- 接口坑备忘：`HOLD_NUM` 单位是股、`HOLD_NUM_CHANGE` 单位也是股（勿被字段名误导）；fflow 返回单位是元；龙虎榜席位明细接口（`RPT_BILLBOARD_DAILYDETAILSBUY/SELL`）的 `BUY/SELL` 单位是元，`RISE_PROBABILITY_3DAY` 是 0-100 的百分比；前端必须把数据源/方法论标注在报告里（不同数据商对「主力」「超大单」阈值定义不同）。

## 行情与缓存策略
- 大盘指数历史（`/api/market`）落盘 `data/marketHistory.json`，接口失败时降级读本地并在响应里标记 `stale`，前端金色提示条明示。
- 个股 K 线（`/api/kline`）落盘 `data/klineHistory.json`，按 `symbol_period` 索引。非交易日 / 接口限流时同样降级读本地，响应头 `X-Kline-Cache: STALE` 标识，前端把 stale 标透传给持有建议回测面板并显示降级提示。

## 首版涨停模块（实时）
导航栏独立 Tab（资产股票分析之后），无落盘，30 秒服务端内存缓存。数据源全部为东方财富公开接口（实测可用）：
- `server/zt.ts`：核心服务端（vite 插件）。
  - `/api/zt/list`：拉 push2his 历史镜像 clist（涨幅排序前 60），过滤 `f3 ≥ 9.9% 且 f2 == f15 已封板`（科创板/创业板按 20% 涨停下浮 0.05 元容差，主板 10%）；通过本地日 K 对比昨日是否封板，区分首板 / 连板（连板数按累计涨幅 / 单板涨幅取对数估算）。
  - `/api/zt/detail?code=sh603xxx`：从列表缓存取基础数据，复用 stockAnalysis 已实测的 fflow / 龙虎榜 / 两融 / 大宗接口拉详情（同源保证口径一致）。
  - `/api/zt/analysis`：涨停分析（60s 缓存）。基于涨停列表聚合：行业统计（按 industry / mainNet / 涨幅）/ 涨停高度分布（首板 / N板 数量 + 最高板龙头）/ 4 套 Top10（封单 / 涨幅 / 换手 / 主力净流入）/ 近 30 个交易日涨停次数（基于日 K 逐股判定）。
- `src/pages/ZtPage.tsx`：独立 Tab 容器（双栏布局，左侧 ZtListPanel + 右侧 ZtAnalysisPanel，窄屏堆叠）。
- `src/components/ZtListPanel.tsx`：双 Tab 列表（首板按封单降序）+ 抽屉式详情（资金流 / 龙虎榜 / 两融 / 大宗交易），60 秒前端自动刷新（接口侧 30s 缓存）。
- `src/components/ZtAnalysisPanel.tsx`：5 个分段（潮汐 / 行业 / 高度 / 排行 / 次数），按涨停股池聚合 + 日 K 涨停次数；涨停股池拉取失败时降级返回 stale 占位响应，前端提示"接口不可用"而非整页报错。
- 接口坑备忘：clist 加 `fltt=2&invt=2` 后 `f2/f4/f15/f18` 是浮点元值（37.94），`f3` 是浮点百分比（19.99 = 19.99%），`f5` 是手、`f6` 是元、`f39` 是封单金额（元）、`f60` 是主力净流入（元）；封单金额 > 0 即视为仍封板中。push2 接口对瞬时高并发不稳定，已切换到 push2his 历史镜像（更稳定但首日计算可能比当日实时有秒级延迟）。分析面板需要给每只涨停股再发一次日 K，受 MAX_CONCURRENCY=4 限流保护；单股 fetchStockDailyKline 失败时按 `item.boardCount` 降级，不阻塞分析。

## 开发命令
```bash
npm run dev      # 启动开发服务器
npm run build    # 构建生产版本
npm run preview  # 预览生产构建
```

## 数据说明
当前使用模拟数据（`data.ts`），后续可接入真实 API（如 Alpha Vantage、CoinGecko 等）替换。
