import { useEffect, useState } from 'react'

/**
 * 在每天指定时间（HH:MM）触发一次回调，到时间后自动滚到下一天。
 * - 启动时挂上 setTimeout；若今日时刻已过则取明天同一时刻
 * - 触发回调完成后，再次 schedule 到下一天同一时刻
 * - 返回「下一次触发时间」Date，便于 UI 显示倒计时或明示
 * - 卸载时 clearTimeout
 */
export function useDailyScheduler(
  callback: () => void,
  hour: number,
  minute: number,
): Date | null {
  const [next, setNext] = useState<Date | null>(null)

  useEffect(() => {
    let timerId: number | null = null
    const schedule = () => {
      const now = new Date()
      const target = new Date(now)
      target.setHours(hour, minute, 0, 0)
      if (target.getTime() <= now.getTime()) {
        // 今天的时刻已过 → 滚到明天
        target.setDate(target.getDate() + 1)
      }
      const ms = target.getTime() - now.getTime()
      setNext(new Date(target))
      timerId = window.setTimeout(() => {
        try {
          callback()
        } catch {
          // 静默吞掉回调异常，不影响定时调度继续
        }
        schedule()
      }, ms)
    }
    schedule()
    return () => {
      if (timerId != null) window.clearTimeout(timerId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callback, hour, minute])

  return next
}