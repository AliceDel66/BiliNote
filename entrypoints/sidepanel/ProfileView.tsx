/** 「我的」Tab：个人学习仪表盘（学习档案 / 五项统计 / 26 周活动热力图 / 课程进度 / 活动洞察）。
 *  数据全部从既有 Dexie 表现算（lib/stats），不落任何新事件表；
 *  仅在 Tab 可见时加载并每 10s 轮询刷新（App 以 visible 传入）。 */
import { useCallback, useEffect, useState } from 'react';
import { Card, ProgressBar, SectionTitle } from '../../components/ui';
import {
  GraduationCapIcon,
  LightbulbIcon,
  ZapIcon,
} from '../../components/icons';
import { db } from '../../lib/storage';
import {
  collectEvents,
  computeStats,
  HEAT_WEEKS,
  type StudyStats,
} from '../../lib/stats';

/** 热力图强度：0 次 = surface-2；1/2/3/≥4 次 = brand-500 的 25/50/75/100% 不透明度 */
const LEVEL_ALPHA = [0, 0.25, 0.5, 0.75, 1] as const;

function levelOf(count: number): number {
  if (count <= 0) return 0;
  if (count >= 4) return 4;
  return count;
}

function cellStyle(level: number): { backgroundColor: string } | undefined {
  return level > 0
    ? { backgroundColor: `rgba(99,102,241,${LEVEL_ALPHA[level]})` }
    : undefined;
}

const CELL_CLASS = 'h-[10px] w-[10px] rounded-[2px]';
const EMPTY_CELL_CLASS = `${CELL_CLASS} bg-surface-2 dark:bg-surface-2-dark`;

/** 累计学习时长：1250 分钟 → "20h 50m"；不足 1 小时 → "45m" */
function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** 直接读 Dexie 计算全部统计；chatTurns 经 topic → session 反查 bvid 归属 */
async function loadStats(): Promise<StudyStats> {
  const [summaries, notes, turns, topics, sessions, videos] = await Promise.all([
    db.summaries.toArray(),
    db.notes.toArray(),
    db.chatTurns.toArray(),
    db.chatTopics.toArray(),
    db.chatSessions.toArray(),
    db.videos.toArray(),
  ]);
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const bvidByTopicId = new Map(
    topics.map((t) => [t.id, sessionById.get(t.sessionId)?.bvid] as const),
  );
  const events = collectEvents({
    summaries,
    notes,
    chatTurns: turns.map((t) => {
      const bvid = bvidByTopicId.get(t.topicId);
      return { createdAt: t.createdAt, status: t.status, ...(bvid ? { bvid } : {}) };
    }),
  });
  return computeStats(events, videos, summaries);
}

export default function ProfileView({ visible }: { visible: boolean }) {
  const [stats, setStats] = useState<StudyStats | null>(null);

  const load = useCallback(async () => {
    try {
      setStats(await loadStats());
    } catch {
      /* IndexedDB 未就绪 */
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => clearInterval(timer);
  }, [visible, load]);

  if (!stats) {
    return <p className="py-12 text-center text-xs text-ink-2 dark:text-ink-2-dark">加载中…</p>;
  }

  const { totals, streaks, daily, courseProgress, insights } = stats;

  const statItems = [
    { value: String(totals.analyzedVideos), label: '分析视频' },
    { value: String(totals.notes), label: '累计笔记' },
    { value: String(totals.qaTurns), label: '累计问答' },
    { value: String(streaks.current), label: '当前连续', unit: '天' },
    { value: String(streaks.longest), label: '最长连续', unit: '天' },
  ];

  // 热力图：daily 按日期升序（共 26*7 天），列主序铺成 7 行 × 26 列，今天固定在右下角
  const days = [...daily.entries()];
  const monthLabels: (string | null)[] = [];
  for (let col = 0; col < HEAT_WEEKS; col++) {
    const day = days[col * 7]?.[0];
    if (!day) {
      monthLabels.push(null);
      continue;
    }
    const prevDay = col > 0 ? days[(col - 1) * 7]?.[0] : undefined;
    const month = Number(day.slice(5, 7));
    const prevMonth = prevDay ? Number(prevDay.slice(5, 7)) : null;
    monthLabels.push(month !== prevMonth ? `${month}月` : null);
  }

  return (
    <>
      {/* 档案头：logo + 本地数据说明 + 累计学习时长 */}
      <Card className="flex items-center gap-3">
        <img src="/icon/128.png" alt="BiliNote" className="h-10 w-10 rounded-[10px]" />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold tracking-tight">学习档案</p>
          <p className="text-xs text-ink-2 dark:text-ink-2-dark">数据仅保存在本地浏览器</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-[17px] font-semibold tnum">
            {formatMinutes(totals.coveredMinutes)}
          </p>
          <p className="text-[11px] text-ink-3 dark:text-ink-3-dark">累计学习时长</p>
        </div>
      </Card>

      {/* 五项统计 */}
      <Card className="grid grid-cols-3 gap-3 sm:grid-cols-5">
        {statItems.map((item) => (
          <div key={item.label} className="text-center">
            <p className="font-mono text-[17px] font-semibold tnum">
              {item.value}
              {item.unit && (
                <span className="ml-0.5 text-[11px] font-normal text-ink-3 dark:text-ink-3-dark">
                  {item.unit}
                </span>
              )}
            </p>
            <p className="mt-0.5 text-[11px] text-ink-3 dark:text-ink-3-dark">{item.label}</p>
          </div>
        ))}
      </Card>

      {/* 学习活动热力图（最近 26 周） */}
      <Card>
        <SectionTitle icon={<ZapIcon />} title="学习活动" />
        <div className="overflow-x-auto">
          <div className="mb-1 flex gap-[2px]">
            {monthLabels.map((label, i) => (
              <span
                key={i}
                className="w-[10px] shrink-0 whitespace-nowrap text-[10px] leading-none text-ink-3 dark:text-ink-3-dark"
              >
                {label}
              </span>
            ))}
          </div>
          <div className="grid grid-flow-col grid-rows-7 gap-[2px]">
            {days.map(([day, count]) => {
              const level = levelOf(count);
              return (
                <div
                  key={day}
                  title={`${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日 · ${count} 次活动`}
                  className={level === 0 ? EMPTY_CELL_CLASS : CELL_CLASS}
                  style={cellStyle(level)}
                />
              );
            })}
          </div>
        </div>
        <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-ink-3 dark:text-ink-3-dark">
          <span>少</span>
          {LEVEL_ALPHA.map((_, level) => (
            <span
              key={level}
              className={level === 0 ? EMPTY_CELL_CLASS : CELL_CLASS}
              style={cellStyle(level)}
            />
          ))}
          <span>多</span>
        </div>
      </Card>

      {/* 课程进度 */}
      <Card>
        <SectionTitle icon={<GraduationCapIcon />} title="课程进度" />
        {courseProgress.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <GraduationCapIcon
              size={40}
              strokeWidth={1.5}
              className="text-ink-3 dark:text-ink-3-dark"
            />
            <p className="text-[15px] font-medium">还没有学习记录</p>
            <p className="text-xs text-ink-2 dark:text-ink-2-dark">
              去课程 Tab 分析第一个视频吧
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {courseProgress.map((v) => (
              <div key={v.bvid} className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate">{v.title}</span>
                  <span className="shrink-0 font-mono text-[11px] tnum text-ink-3 dark:text-ink-3-dark">
                    {v.analyzedParts}/{v.totalParts} 分P
                  </span>
                </div>
                <ProgressBar value={(v.analyzedParts / v.totalParts) * 100} />
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* 活动洞察（最近 7 天） */}
      <Card>
        <SectionTitle icon={<LightbulbIcon />} title="活动洞察" />
        <ul className="space-y-2">
          <li className="flex items-center justify-between gap-2">
            <span className="text-ink-2 dark:text-ink-2-dark">本周新增笔记</span>
            <span className="font-mono tnum">{insights.weekNotes}</span>
          </li>
          <li className="flex items-center justify-between gap-2">
            <span className="text-ink-2 dark:text-ink-2-dark">本周问答</span>
            <span className="font-mono tnum">{insights.weekQa}</span>
          </li>
          <li className="flex items-center justify-between gap-2">
            <span className="shrink-0 text-ink-2 dark:text-ink-2-dark">最常学习课程</span>
            {insights.topCourse ? (
              <span className="min-w-0 truncate text-right">
                {insights.topCourse.title}
                <span className="text-ink-3 dark:text-ink-3-dark">
                  {' '}
                  · {insights.topCourse.events} 次
                </span>
              </span>
            ) : (
              <span className="text-ink-3 dark:text-ink-3-dark">—</span>
            )}
          </li>
        </ul>
      </Card>
    </>
  );
}
