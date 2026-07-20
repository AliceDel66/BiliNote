#!/usr/bin/env node
/**
 * B站接口实网只读验证（不参与扩展构建）。
 * 流程：popular（免登录）→ view → wbi 签名 player/wbi/v2 → 字幕轨 → 字幕 JSON。
 * 与 lib/bilibili 同一套算法（wbi 签名逻辑在 test/wbi.test.ts 中有测试向量单测）。
 */
import { createHash } from 'node:crypto';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');

function getMixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join('').slice(0, 32);
}

function signWbi(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey, subKey);
  const wts = Math.floor(Date.now() / 1000);
  const all = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${query}&w_rid=${md5(query + mixinKey)}`;
}

async function fetchJson(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com' },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

const basename = (url) => (url.split('/').pop() ?? '').replace(/\.[^.]*$/, '');

async function main() {
  console.log('== BiliNote B站接口实网验证 ==');

  // 1. wbi keys
  const nav = await fetchJson('https://api.bilibili.com/x/web-interface/nav');
  const imgKey = basename(nav?.data?.wbi_img?.img_url ?? '');
  const subKey = basename(nav?.data?.wbi_img?.sub_url ?? '');
  if (!imgKey || !subKey) throw new Error('nav 接口未返回 wbi_img');
  console.log(`[ok] wbi keys: img_key=${imgKey} sub_key=${subKey}`);

  // 2. 热门列表
  const popular = await fetchJson('https://api.bilibili.com/x/web-interface/popular');
  if (popular.code !== 0) throw new Error(`popular code=${popular.code}`);
  const bvids = (popular.data?.list ?? []).map((v) => v.bvid).slice(0, 12);
  console.log(`[ok] popular 返回 ${bvids.length} 个候选 bvid`);

  // 3. 逐个尝试找有字幕的视频
  for (const bvid of bvids) {
    console.log(`\n-- 尝试 ${bvid} --`);
    const view = await fetchJson(
      `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    );
    if (view.code !== 0) {
      console.log(`  view 失败 code=${view.code}，跳过`);
      continue;
    }
    const { aid, title, pages } = view.data;
    const page = pages?.[0];
    console.log(`  标题：《${title}》 分P数=${pages?.length ?? 0}`);
    if (!page) continue;

    const signed = signWbi({ aid, cid: page.cid, bvid }, imgKey, subKey);
    const v2 = await fetchJson(`https://api.bilibili.com/x/player/wbi/v2?${signed}`);
    if (v2.code !== 0) {
      console.log(`  wbi/v2 失败 code=${v2.code} message=${v2.message}，跳过`);
      continue;
    }
    console.log(`[ok] wbi 签名通过（code=0）`);

    const subs = v2.data?.subtitle?.subtitles ?? [];
    console.log(`  字幕轨数量：${subs.length}`);
    if (subs.length === 0) continue;
    subs.forEach((s) => console.log(`    - ${s.lan} (${s.lan_doc})`));

    const track =
      subs.find((s) => s.lan.includes('zh') && !s.lan.startsWith('ai')) ?? subs[0];
    const url = track.subtitle_url.startsWith('//')
      ? `https:${track.subtitle_url}`
      : track.subtitle_url;
    const subJson = await fetchJson(url);
    const cues = subJson.body ?? [];
    console.log(`[ok] 选择字幕轨 ${track.lan} (${track.lan_doc})，cue 数量=${cues.length}`);
    if (cues[0]) {
      console.log(
        `  首条 cue: [${cues[0].from}s ~ ${cues[0].to}s] ${String(cues[0].content).slice(0, 40)}`,
      );
    }
    console.log('\n== 验证通过 ==');
    return;
  }

  console.log(`\n[WARN] 尝试了 ${bvids.length} 个热门视频均未找到字幕（no subtitle found）`);
  console.log('[HINT] 匿名（无 Cookie）请求时 B站常返回空字幕列表；扩展内带登录 Cookie 后通常可见。wbi 签名链路已验证通过。');
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(`[FAIL] ${e.message}`);
  process.exit(1);
});
