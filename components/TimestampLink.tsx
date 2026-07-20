/** 时间戳 pill（产品签名元素）：mm:ss 等宽数字，点击跳转播放器。
 *  所有可跳转时间点统一使用本组件。 */
import { formatTimestamp } from '../lib/types';

export default function TimestampLink(props: {
  seconds: number;
  onSeek: (seconds: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => props.onSeek(props.seconds)}
      className="inline-flex items-center rounded-full bg-brand-soft dark:bg-brand-soft-dark px-2 py-[3px] font-mono text-[11px] tnum text-brand-500 dark:text-brand-300 transition-colors duration-150 hover:bg-brand-ring dark:hover:bg-brand-ring-dark cursor-pointer border-0 shrink-0"
      title="跳转到播放器对应位置"
    >
      {formatTimestamp(props.seconds)}
    </button>
  );
}
