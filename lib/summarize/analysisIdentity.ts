/**
 * 分析结果 ↔ 视频身份绑定（跨层契约 C1）。
 * ANALYZE_PORT 的 done / done-cached / error / no-subtitle 事件携带 {bvid, cid, p}：
 * 切视频后旧端口的迟到事件必须整体丢弃；「存为笔记」前校验结果身份，防止
 * A 视频的分析结果写进 B 视频的笔记。纯函数，可单测。
 */

/** 分析结果绑定的视频身份 */
export interface VideoIdentity {
  bvid: string;
  cid: number;
  /** 分 P 序号（1 起） */
  p?: number;
}

/**
 * 判断分析端口事件是否为「上一个视频的迟到事件」：
 * - 事件不带身份字段（chunk 进度事件 / 旧版本后台）→ 无法判断，不拦截；
 * - 当前无视频上下文 → 带身份的事件一律丢弃；
 * - bvid 不匹配，或 cid 存在且不匹配 → 丢弃。
 */
export function isStaleAnalyzeEvent(
  event: { bvid?: string; cid?: number },
  current: { bvid: string; cid: number } | null,
): boolean {
  if (event.bvid === undefined && event.cid === undefined) return false;
  if (!current) return true;
  if (event.bvid !== undefined && event.bvid !== current.bvid) return true;
  if (event.cid !== undefined && event.cid !== current.cid) return true;
  return false;
}

/** 「存为笔记」身份守卫：结果与当前视频 bvid + cid 完全一致才允许保存 */
export function canSaveAnalysisToVideo(
  result: { bvid: string; cid: number } | null | undefined,
  current: { bvid: string; cid: number } | null | undefined,
): boolean {
  if (!result || !current) return false;
  return result.bvid === current.bvid && result.cid === current.cid;
}
