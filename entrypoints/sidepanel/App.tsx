/** Side Panel 主界面：当前视频卡片 + 一键分析 + 流式结果渲染 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import TimestampLink from '../../components/TimestampLink';
import { formatTimestamp } from '../../lib/types';
import {
  ANALYZE_PORT,
  type AnalyzePortEvent,
  type VideoContextInfo,
} from '../../lib/messages';
import type { AnalysisResult } from '../../lib/summarize';

type Status =
  | 'loading'
  | 'no-video'
  | 'ready'
  | 'analyzing'
  | 'done'
  | 'no-subtitle'
  | 'error';

interface ProgressState {
  text: string;
  streamText: string;
}

export default function App() {
  const [status, setStatus] = useState<Status>('loading');
  const [ctx, setCtx] = useState<VideoContextInfo | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [cached, setCached] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<ProgressState>({ text: '', streamText: '' });
  const portRef = useRef<Browser.runtime.Port | null>(null);
  const ctxRef = useRef<VideoContextInfo | null>(null);
  ctxRef.current = ctx;

  const refreshContext = useCallback(async () => {
    try {
      const resp = await browser.runtime.sendMessage({ type: 'getVideoContext' });
      const next = (resp?.data ?? null) as VideoContextInfo | null;
      const prev = ctxRef.current;
      setCtx(next);
      if (!next) {
        setStatus((s) => (s === 'analyzing' ? s : 'no-video'));
        return;
      }
      // 切换了视频/分P → 重置结果视图
      if (!prev || prev.bvid !== next.bvid || prev.p !== next.p) {
        setResult(null);
        setCached(false);
        setError('');
        setStatus((s) => (s === 'analyzing' ? s : 'ready'));
      } else {
        setStatus((s) => (s === 'loading' || s === 'no-video' ? 'ready' : s));
      }
    } catch {
      setStatus((s) => (s === 'analyzing' ? s : 'no-video'));
    }
  }, []);

  useEffect(() => {
    void refreshContext();
    const timer = setInterval(() => void refreshContext(), 1500);
    return () => clearInterval(timer);
  }, [refreshContext]);

  useEffect(() => () => portRef.current?.disconnect(), []);

  const stopPort = () => {
    portRef.current?.disconnect();
    portRef.current = null;
  };

  const analyze = (force: boolean) => {
    const c = ctxRef.current;
    if (!c) return;
    stopPort();
    setStatus('analyzing');
    setResult(null);
    setCached(false);
    setError('');
    setProgress({ text: '准备中…', streamText: '' });

    const port = browser.runtime.connect({ name: ANALYZE_PORT });
    portRef.current = port;
    port.onMessage.addListener((e: AnalyzePortEvent) => {
      switch (e.type) {
        case 'chunk-start':
          setProgress((p) => ({ ...p, text: `正在分析片段 ${e.index + 1}/${e.total}…` }));
          break;
        case 'chunk-done':
          setProgress((p) => ({ ...p, text: `片段 ${e.index + 1}/${e.total} 完成：${e.preview}` }));
          break;
        case 'reduce-start':
          setProgress((p) => ({ ...p, text: '正在生成课程大纲…' }));
          break;
        case 'reduce-delta':
          setProgress((p) => ({ ...p, streamText: e.text }));
          break;
        case 'done':
          setResult(e.result);
          setStatus('done');
          stopPort();
          break;
        case 'done-cached':
          setResult(e.result);
          setCached(true);
          setStatus('done');
          stopPort();
          break;
        case 'no-subtitle':
          setStatus('no-subtitle');
          stopPort();
          break;
        case 'error':
          setError(e.message);
          setStatus('error');
          stopPort();
          break;
      }
    });
    port.onDisconnect.addListener(() => {
      portRef.current = null;
    });
    port.postMessage({ type: 'analyze', bvid: c.bvid, p: c.p, force });
  };

  const cancel = () => {
    portRef.current?.postMessage({ type: 'cancel' });
    stopPort();
    setStatus(ctxRef.current ? 'ready' : 'no-video');
  };

  const seek = (seconds: number) => {
    void browser.runtime
      .sendMessage({ type: 'seek', seconds, p: ctxRef.current?.p })
      .catch(() => {});
  };

  const openOptions = () => void browser.runtime.openOptionsPage();

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 text-neutral-800 dark:text-neutral-100 text-sm">
      <header className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-700 bg-neutral-50/95 dark:bg-neutral-900/95">
        <h1 className="font-bold text-base">BiliNote</h1>
        <button
          type="button"
          onClick={openOptions}
          className="text-xs text-neutral-500 dark:text-neutral-400 hover:text-sky-600 dark:hover:text-sky-400"
        >
          模型设置
        </button>
      </header>

      <main className="p-4 space-y-4">
        {status === 'loading' && <p className="text-neutral-500">加载中…</p>}

        {status === 'no-video' && (
          <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 p-4 text-neutral-500 dark:text-neutral-400">
            <p>未检测到 B站视频页。</p>
            <p className="mt-1 text-xs">请打开 bilibili.com 的任意视频播放页，这里会自动出现「一键分析」。</p>
          </div>
        )}

        {ctx && status !== 'no-video' && status !== 'loading' && (
          <section className="rounded-lg border border-neutral-200 dark:border-neutral-700 p-4 bg-white dark:bg-neutral-800">
            <h2 className="font-medium leading-snug line-clamp-2">{ctx.title}</h2>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              UP 主：{ctx.owner || '未知'} · 第 {ctx.p} P · 时长 {formatTimestamp(ctx.duration)}
              {ctx.pages.length > 1 && ctx.pages[ctx.p - 1] && ` · ${ctx.pages[ctx.p - 1].part}`}
            </p>

            {status === 'ready' && (
              <button
                type="button"
                onClick={() => analyze(false)}
                className="mt-3 w-full rounded-md bg-sky-600 hover:bg-sky-500 text-white py-2 font-medium"
              >
                一键分析
              </button>
            )}

            {status === 'analyzing' && (
              <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-sky-600 dark:text-sky-400 animate-pulse">{progress.text || '分析中…'}</p>
                  <button
                    type="button"
                    onClick={cancel}
                    className="text-xs text-neutral-500 hover:text-red-500"
                  >
                    取消
                  </button>
                </div>
                {progress.streamText && (
                  <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-neutral-100 dark:bg-neutral-900 p-2 text-xs text-neutral-500 dark:text-neutral-400">
                    {progress.streamText}
                  </pre>
                )}
              </div>
            )}

            {status === 'no-subtitle' && (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  该视频没有可用字幕。常见原因：UP 主未上传字幕、未开启 AI 字幕，或当前未登录 B站导致接口受限。
                </p>
                <button
                  type="button"
                  onClick={() => analyze(true)}
                  className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 py-1.5 text-xs hover:border-sky-500"
                >
                  重试
                </button>
              </div>
            )}

            {status === 'error' && (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => analyze(true)}
                    className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-600 py-1.5 text-xs hover:border-sky-500"
                  >
                    重试
                  </button>
                  <button
                    type="button"
                    onClick={openOptions}
                    className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-600 py-1.5 text-xs hover:border-sky-500"
                  >
                    检查模型设置
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {status === 'done' && result && (
          <section className="space-y-4">
            <div className="flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
              <span>
                {cached ? '缓存结果' : '分析完成'}
                {result.tokenUsage && ` · 输入约 ${result.tokenUsage.estimatedInput} tokens`}
              </span>
              <button
                type="button"
                onClick={() => analyze(true)}
                className="hover:text-sky-600 dark:hover:text-sky-400"
              >
                重新生成
              </button>
            </div>

            {result.rawMarkdown ? (
              <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 p-4 bg-white dark:bg-neutral-800">
                <p className="text-xs text-amber-600 dark:text-amber-400 mb-2">
                  模型未返回标准结构，以下为原文展示：
                </p>
                <pre className="whitespace-pre-wrap text-xs">{result.rawMarkdown}</pre>
              </div>
            ) : (
              <>
                {result.outline.length > 0 && (
                  <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 p-4 bg-white dark:bg-neutral-800">
                    <h3 className="font-medium mb-2">课程大纲</h3>
                    <ul className="space-y-1.5">
                      {result.outline.map((o, i) => (
                        <li key={i} className="flex gap-2">
                          <TimestampLink seconds={o.time} onSeek={seek} />
                          <span>{o.title}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {result.sections.map((s, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-neutral-200 dark:border-neutral-700 p-4 bg-white dark:bg-neutral-800"
                  >
                    <h3 className="font-medium mb-1">
                      {s.title}
                      <span className="ml-2 text-xs font-normal">
                        <TimestampLink seconds={s.start} onSeek={seek} />
                        {' - '}
                        {formatTimestamp(s.end)}
                      </span>
                    </h3>
                    <ul className="list-disc pl-5 space-y-1 text-neutral-700 dark:text-neutral-300">
                      {s.points.map((p, j) => (
                        <li key={j}>{p}</li>
                      ))}
                    </ul>
                  </div>
                ))}

                {result.keyPoints.length > 0 && (
                  <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 p-4 bg-white dark:bg-neutral-800">
                    <h3 className="font-medium mb-2">重点 / 难点讲解</h3>
                    <ul className="space-y-2">
                      {result.keyPoints.map((k, i) => (
                        <li key={i}>
                          <p className="font-medium">
                            {k.time !== undefined && (
                              <>
                                <TimestampLink seconds={k.time} onSeek={seek} />{' '}
                              </>
                            )}
                            {k.point}
                          </p>
                          {k.explanation && (
                            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                              {k.explanation}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
