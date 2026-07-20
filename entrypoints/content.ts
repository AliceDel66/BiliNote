/**
 * Content Script：识别 B站播放页（含 SPA 路由切换），上报视频上下文；
 * 处理 seek（同 P 直接 currentTime，跨 P 先跳 ?p=N&t=S）。
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';

interface PageContext {
  bvid: string;
  p: number;
  title: string;
  url: string;
}

function currentContext(): PageContext | null {
  const m = /\/video\/(BV[0-9A-Za-z]+)/.exec(location.pathname);
  if (!m) return null;
  const pParam = Number(new URLSearchParams(location.search).get('p') ?? '1');
  const p = Number.isFinite(pParam) && pParam >= 1 ? Math.floor(pParam) : 1;
  const title = document.title.replace(/_哔哩哔哩_bilibili$/, '').trim();
  return { bvid: m[1], p, title, url: location.href };
}

async function seekInPage(seconds: number, p?: number): Promise<{ jumped: boolean }> {
  const ctx = currentContext();
  if (p && ctx && p !== ctx.p) {
    // 跨 P：整页跳转，播放器会从 t 参数起播
    location.href = `https://www.bilibili.com/video/${ctx.bvid}?p=${p}&t=${Math.floor(seconds)}`;
    return { jumped: true };
  }
  const video = document.querySelector('video');
  if (video) {
    video.currentTime = seconds;
    await video.play().catch(() => {});
  }
  return { jumped: false };
}

export default defineContentScript({
  matches: ['*://*.bilibili.com/video/*'],
  main() {
    let lastUrl = location.href;

    const report = () => {
      const ctx = currentContext();
      if (ctx) {
        void browser.runtime
          .sendMessage({ type: 'reportVideoContext', context: ctx })
          .catch(() => {});
      }
    };

    // SPA 路由变化检测（轮询，1s 内可感知）
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        report();
      }
    }, 500);
    report();

    browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === 'queryContext') {
        sendResponse(currentContext());
        return false;
      }
      if (msg?.type === 'seek') {
        void seekInPage(msg.seconds, msg.p).then(sendResponse);
        return true;
      }
      return false;
    });
  },
});
