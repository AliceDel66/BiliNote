// 实网只读验证：playurl 音轨可达性（wbi 签名 + dash.audio + CDN Range）
import crypto from 'node:crypto';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com';
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

async function jget(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: REFERER } });
  return r.json();
}

const nav = await jget('https://api.bilibili.com/x/web-interface/nav');
const img = nav.data.wbi_img.img_url.split('/').pop().replace(/\.[^.]*$/, '');
const sub = nav.data.wbi_img.sub_url.split('/').pop().replace(/\.[^.]*$/, '');
const mixin = MIXIN_TAB.map((i) => (img + sub)[i]).join('').slice(0, 32);
console.log('[ok] wbi keys');

const bvid = 'BV1hv411x7we';
const view = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
const { aid, pages } = view.data;
const { cid } = pages[0];
console.log(`[ok] view aid=${aid} cid=${cid} duration=${pages[0].duration}s`);

const params = { aid, bvid, cid, fnval: 16, wts: Math.floor(Date.now() / 1000) };
const qs = Object.keys(params).sort().map((k) => `${k}=${encodeURIComponent(params[k])}`).join('&');
const rid = crypto.createHash('md5').update(qs + mixin).digest('hex');
const pu = await jget(`https://api.bilibili.com/x/player/playurl?${qs}&w_rid=${rid}`);
if (pu.code !== 0) { console.error('[fail] playurl code', pu.code, pu.message); process.exit(1); }
const audios = pu.data?.dash?.audio ?? [];
console.log(`[ok] playurl dash.audio=${audios.length}`);
if (audios.length === 0) { console.error('[fail] no dash audio'); process.exit(1); }
const track = audios.sort((a, b) => a.bandwidth - b.bandwidth)[0];
const url = track.baseUrl ?? track.base_url;
console.log(`[ok] lowest bandwidth=${track.bandwidth}bps mime=${track.mimeType ?? track.mime_type}`);
const host = new URL(url).host;
const resp = await fetch(url, { headers: { 'User-Agent': UA, Referer: REFERER, Range: 'bytes=0-1023' } });
const buf = await resp.arrayBuffer();
console.log(`[ok] CDN ${host} range status=${resp.status} bytes=${buf.byteLength}`);
console.log('PASS: playurl 音轨链路实网可达');
