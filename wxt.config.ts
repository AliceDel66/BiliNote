import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { REQUIRED_HOST_PERMISSIONS } from './lib/host-permissions';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'BiliNote',
    description: 'AI 视频学习助手：自动提取 B站视频字幕，用你自己的 AI 模型生成课程大纲、分段总结与时间戳笔记。',
    permissions: ['storage', 'sidePanel', 'scripting', 'declarativeNetRequest'],
    host_permissions: REQUIRED_HOST_PERMISSIONS,
    optional_host_permissions: ['*://*/*'],
    action: {
      default_title: 'BiliNote - AI 视频学习助手',
    },
  },
});
