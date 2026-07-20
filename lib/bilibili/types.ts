/** B站 API 相关类型 */
export interface Cue {
  /** 秒 */
  start: number;
  /** 秒 */
  end: number;
  text: string;
}

export interface VideoPage {
  cid: number;
  page: number;
  part: string;
  duration: number;
}

export interface VideoInfo {
  bvid: string;
  aid: number;
  title: string;
  cover: string;
  owner: string;
  ownerMid: number;
  duration: number;
  pages: VideoPage[];
}

export interface SubtitleTrack {
  id: number;
  lan: string;
  lanDoc: string;
  subtitleUrl: string;
  isAi: boolean;
}

export interface SubtitleResult {
  track: SubtitleTrack;
  /** 可用轨道总数 */
  tracksCount: number;
  cues: Cue[];
}
