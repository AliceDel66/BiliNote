/** 可点击的时间戳锚点（mm:ss），点击触发播放器跳转 */
import { formatTimestamp } from '../lib/types';

export default function TimestampLink(props: {
  seconds: number;
  onSeek: (seconds: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => props.onSeek(props.seconds)}
      className="font-mono text-sky-600 dark:text-sky-400 hover:underline cursor-pointer bg-transparent border-0 p-0"
      title="跳转到播放器对应位置"
    >
      {formatTimestamp(props.seconds)}
    </button>
  );
}
