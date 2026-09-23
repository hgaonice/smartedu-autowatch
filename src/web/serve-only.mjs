/**
 * 只起服务、不弹 Chrome 窗口。
 *
 * 用途：
 *   · 调试前端（改完 ui.html 刷新浏览器即可，不用反复开关窗口）
 *   · 用户已经有自己习惯的浏览器，想用那个打开
 *   · CI / 自动化测试
 *
 * 用法：node src/web/serve-only.mjs [端口]
 */

import { createServer } from './server.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.argv[2] || process.env.SMARTEDU_UI_PORT || 8477);

const server = createServer();

server.listen(PORT, HOST, () => {
  console.log(`界面地址：http://${HOST}:${PORT}/`);
  console.log('（只起了服务，没有自动开窗口；用浏览器打开上面的地址即可）');
  console.log('Ctrl+C 退出。');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(
      `端口 ${PORT} 已被占用。\n` +
        `  可能已有一个实例在跑 —— 直接打开 http://${HOST}:${PORT}/ 看看；\n` +
        `  或者换端口：node src/web/serve-only.mjs ${PORT + 1}`,
    );
    process.exit(1);
  }
  console.error(`启动失败：${e.message}`);
  process.exit(1);
});
