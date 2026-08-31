'use strict';

// 后端启动期显示的 loading 页（真实 UI 未加载前）。
//
// 这里的拖拽区必须【只】覆盖顶栏，不能整页 drag。Electron 的可拖拽区域是窗口级
// 状态：渲染进程解析 CSS 后上报给主进程，而导航到一个「完全没有任何 app-region
// 声明」的新页面时，Electron 不会清空既有区域，旧区域会原样残留在窗口上。
// splash 之后加载的第一个界面若是登录门（LoginGate 不声明 app-region），整页 drag
// 就会盖住它，按钮点不动、只能拖窗口（PR #127 引入，见 splash.test.js）。
const SPLASH_TITLEBAR_HEIGHT = 36;   // 与 App.tsx 顶栏 height 对齐
const SPLASH_CONTROLS_WIDTH = 150;   // 与 App.tsx 顶栏 paddingRight 对齐

function loadingHtml({ productName, zh = false } = {}) {
  const text = zh ? `正在启动 ${productName}…` : `Starting ${productName}…`;
  return (
    'data:text/html;charset=utf-8,' +
    encodeURIComponent(
      // Match the React app's actual background (index.css --bg0) so launch
      // doesn't flash from dark splash to light app.
      //
      // titleBarStyle:'hidden' 下窗口顶部默认【不可拖动】——必须由页面用
      // -webkit-app-region:drag 显式声明拖拽区。顶栏尺寸与真实 UI 对齐
      // （App.tsx：height 36、右侧让出 150px 给 titleBarOverlay 的窗口控件）。
      '<html style="background:#f0f4fa;margin:0;height:100%">' +
      '<body style="margin:0;height:100vh;position:relative;' +
      'display:flex;align-items:center;justify-content:center">' +
      // 拖拽条：贴顶、高 36、右侧让出 150px 给 titleBarOverlay 的窗口控件。
      // 只覆盖顶栏，绝不整页——整页 drag 会残留到下一个页面（见文件头注释）。
      '<div style="position:absolute;top:0;left:0;right:' + SPLASH_CONTROLS_WIDTH + 'px;' +
      'height:' + SPLASH_TITLEBAR_HEIGHT + 'px;-webkit-app-region:drag"></div>' +
      '<p style="color:#8aa3bf;font-family:system-ui,sans-serif;font-size:15px">' + text + '</p>' +
      '</body></html>'
    )
  );
}

module.exports = { loadingHtml, SPLASH_TITLEBAR_HEIGHT, SPLASH_CONTROLS_WIDTH };
