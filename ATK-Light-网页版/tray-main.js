// ATK-Light 托盘宿主：点击托盘图标，在图标上方弹出面板
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, session, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

/* 轻量日志：排查「面板闪两次」这类时序问题用。
   位置：%TEMP%tk-panel.log，每次启动清空。 */
const LOG_FILE = path.join(os.tmpdir(), 'atk-panel.log');
function logLine(msg){
  try { fs.appendFileSync(LOG_FILE, new Date().toISOString().slice(11, 23) + ' ' + msg + String.fromCharCode(10)); } catch (e) {}
}

// —— 全局错误捕获，便于排查启动问题 ——
process.on('uncaughtException', (err) => { console.error('[uncaught]', err); });
process.on('unhandledRejection', (err) => { console.error('[unhandled]', err); });

/* 窗口比面板每边各多 2px。
   完全不多余量（400=400）时，面板的圆角正好压在窗口矩形边缘上，
   会被窗口边界优先裁掉 —— 浏览器画得出圆角，但窗口矩形裁掉它，看起来就是直角。
   2px 足够让圆角完整渲染，肉眼又看不到那点缝。 */
const WIN_W = 400;
const WIN_H = 676;
let tray = null;
let win = null;
let blurTimer = null;      // 失焦收起的延时器（见 win.on('blur')）
let ignoreBlurUntil = 0;   // 刚打开面板的一小段时间内忽略失焦（托盘点击会带一次 blur）
let firstPaintReady = false;  // 窗口是否已完成首帧绘制（ready-to-show）
let panelVisible = false;     // 逻辑可见状态：窗口常驻，靠 opacity 控制显示

// —— 让面板里的 WebHID 能直接连设备（自动授权 + 自动选设备）——
function setupHid(){
  const ses = session.defaultSession;
  ses.setDevicePermissionHandler(() => true);
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const list = details.deviceList || [];
    // 优先有线鼠标（0x1286），其次任意 ATK 设备（0x373B）
    const pick =
      list.find(d => d.vendorId === 0x373b && d.productId === 0x1286) ||
      list.find(d => d.vendorId === 0x373b) ||
      list[0];
    callback(pick ? pick.deviceId : undefined);
  });
}

function createWindow(){
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    show: false,
    frame: false,
    /* 用 Windows 11 的 DWM 原生圆角（就是 WorkBuddy 那种窗口圆角），
       不用 CSS 画。roundedCorners 在无边框窗口上默认是 true，
       之前我们显式设成 false 把它关掉了，所以四角一直是直角。 */
    transparent: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    roundedCorners: true,
    thickFrame: false,
    backgroundColor: '#0d0f12',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      /* 隐藏时不要节流：否则 Chromium 会释放合成层，再 show() 时要重建，
         录屏里表现为弹出后约 100ms 的半透明空白期（"闪一下"）。 */
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'), { query: { tray: '1', v: app.getVersion() } });
  /* 首帧可绘制：did-finish-load 只代表 DOM 加载完，Chromium 真正画出内容还要再晚一拍。
     不等这一步就 show()，会先显示一张空白/半透明窗口（录屏里看到的那 4 帧）。 */
  win.once('ready-to-show', () => { firstPaintReady = true; });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  // 「收起面板」请求：由 preload 通过 IPC 发来
  ipcMain.on('panel-hide', () => { hidePanel(); });

  /* 窗口是实色的（不透明），切主题时必须同步窗口底色，
     否则面板换成浅色、窗口还留着深色，四周会露出一圈深色边框。 */
  ipcMain.on('window-bg', (e, color) => {
    const c = String(color || '');
    if (!/^#[0-9a-fA-F]{6}$/.test(c)) return;
    try { if (win && !win.isDestroyed()) win.setBackgroundColor(c); } catch (err) {}
  });

  /* 「退出应用」：渲染层那个按钮以前只改了个文字，进程根本没退。
     这里补上真正的退出通道——先标记 isQuitting，避免被 hide-on-close 之类逻辑拦住。 */
  /* 打开外部链接：必须由主进程执行。
     preload 跑在 sandbox 里，拿不到 shell 模块（require('electron').shell 是 undefined），
     所以渲染层只能发请求上来，这里用主进程的 shell 去打开。 */
  ipcMain.handle('open-external', async (e, url) => {
    try {
      const u = String(url || '');
      if (!/^https?:\/\//i.test(u)) return { ok: false, error: '只允许 http/https 链接' };
      await shell.openExternal(u);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  /* 托盘图标显示电量：渲染层用 canvas 画好 PNG 传上来，这里 setImage。
     为什么要渲染层画：主进程没有 DOM / canvas，纯 JS 手写位图又看不清数字。 */
  ipcMain.on('tray-battery', (e, payload) => {
    if (!tray) return;
    const { dataUrl, name, pct, charging } = payload || {};

    /* dataUrl === null 表示「当前没有在线设备」，恢复原始静态图标 */
    if (dataUrl === null) {
      try {
        const orig = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-32.png'));
        if (!orig.isEmpty()) tray.setImage(orig);
      } catch (err) {}
      tray.setToolTip('ATK-Light\u000A无设备在线');
      return;
    }

    try {
      if (dataUrl) {
        const img = nativeImage.createFromDataURL(String(dataUrl));
        if (!img.isEmpty()) tray.setImage(img);
      }
    } catch (err) { /* 画坏了就保持原图，不影响运行 */ }

    /* 悬停提示：照 ATK HUB 的格式，两行
         第一行  ATK-Light
         第二行  设备名 · 状态    电量%
       中间用空格拉开，电量和状态分列两侧，扫一眼就能读出两个信息。 */
    if (pct != null) {
      const status = charging ? '充电中' : '在线';
      /* 和官方 HUB 一致：三段都用「 · 」分隔，电量前也有，
         之前用空格拉开，看起来像少了个符号。 */
      const line2 = name ? `${name} · ${status} · ${pct}%` : `${status} · ${pct}%`;
      const finalTip = `ATK-Light\u000A${line2}`;
      tray.setToolTip(finalTip);
    }
  });

  ipcMain.on('app-quit', () => {
    app.isQuitting = true;
    if (tray) { try { tray.destroy(); } catch (e) {} tray = null; }
    if (win && !win.isDestroyed()) { try { win.destroy(); } catch (e) {} }
    app.quit();
    // 兜底：个别情况下 quit 会被异步任务拖住，2 秒后强制退出
    setTimeout(() => { try { process.exit(0); } catch (e) {} }, 2000);
  });
  /* 失焦收起：必须加延时判断。
     Windows 上点托盘图标、系统对话框（confirm）、窗口切换的瞬间都会发一次 blur，
     原来的「一 blur 就 hide」会被这些瞬时事件误触发，表现为「刚打开/刚点一下就没了」。
     这里改为：失焦后等 500ms，若期间没有重新获得焦点才真正收起。 */
  win.on('blur', () => {
    if (!win || win.webContents.isDevToolsOpened()) return;
    if (Date.now() < ignoreBlurUntil) {           // 刚打开，忽略托盘点击带来的瞬时失焦
      logLine('blur 被忽略（ignoreBlurUntil 内）');
      return;
    }
    clearTimeout(blurTimer);
    logLine('blur -> 500ms 后收起');
    blurTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      if (win.webContents.isDevToolsOpened()) return;
      /* 这里原本还有一句 if (win.isFocused()) return;
         但改成常驻透明窗口后，Windows 上 isFocused() 会返回过期的 true——
         blur 已经发生、面板明明该收起了，它却说"还聚焦着"，于是跳过收起。
         这就是「有概率点外面不收回」的根因。改为只靠 focus 事件取消计时。 */
      logLine('blur 到点 -> hidePanel');
      hidePanel();
    }, 500);
  });
  win.on('focus', () => { logLine('focus -> 取消收起'); clearTimeout(blurTimer); });
  win.on('closed', () => { win = null; });
}

// 把窗口摆到托盘图标正上方（底部任务栏），越界时贴边
function positionWindow(){
  if (!win || !tray) return;
  const tb = tray.getBounds();
  const display = screen.getDisplayMatching(tb);
  const wa = display.workArea;
  const [w, h] = win.getSize();

  let x = Math.round(tb.x + tb.width / 2 - w / 2);
  let y = Math.round(tb.y - h - 6);          // 图标上方

  // 托盘在顶部时改为向下弹
  if (tb.y < wa.y + wa.height / 2) y = Math.round(tb.y + tb.height + 6);

  x = Math.min(Math.max(x, wa.x + 4), wa.x + wa.width - w - 4);
  y = Math.min(Math.max(y, wa.y + 4), wa.y + wa.height - h - 4);
  // 位置没变就不设——对隐藏窗口反复 setPosition，show 时会出现一帧停在旧位置的闪烁
  const [cx, cy] = win.getPosition();
  if (cx !== x || cy !== y) win.setPosition(x, y, false);
}

/* 收起面板。
   关键（实测录屏得出）：隐藏状态下的 setPosition 会被延迟到下次 show 才生效，
   于是 show 的第一帧停在旧位置，紧接着再被挪到托盘上方 —— 看起来就是"闪一下"。
   所以收起时趁不可见先把位置摆好，下次 show 直接出现在正确位置，不再跳。 */
/* 收起面板：不 hide，只把透明度归零。
   原因（120fps 录屏逐帧实测）：win.hide() 会让 Chromium 释放合成层的 GPU 纹理，
   再 show() 时要逐帧重建——录屏里表现为「完整一帧 → 掉到 9% → 线性爬升 125ms → 稳定」。
   改成常驻透明后，渲染管线一直活着，show 只是把 opacity 从 0 拨到 1，一帧到位。 */
function hidePanel(){
  if (!win || win.isDestroyed()) return;
  clearTimeout(blurTimer);
  logLine('hidePanel (opacity=0)');
  panelVisible = false;
  win.setIgnoreMouseEvents(true);   // 看不见时不挡鼠标
  win.setOpacity(0);
  positionWindow();
}

let lastToggleAt = 0;   // 托盘点击防抖时间戳（见 toggle 里的说明）
function toggle(){
  /* 防抖：Windows 上托盘图标单击会连发两次 click——
     第一次走"不可见→show"，第二次立刻走"可见→hide"，
     录屏逐帧看就是「面板完整出现 1 帧（258）→ 立刻消失（259）→ 再慢慢重绘（260-269）」。
     250ms 内的第二次点击直接忽略。 */
  const now = Date.now();
  const gap = now - lastToggleAt;
  if (gap < 250) { logLine(`toggle 被忽略（距上次 ${gap}ms）`); return; }
  lastToggleAt = now;

  if (!win) createWindow();
  logLine(`toggle 执行 visible=${panelVisible} gap=${gap}ms`);
  if (panelVisible) { hidePanel(); return; }
  showPanel(null);
}

/* 显示面板；message 有值时顺带在页面里弹一条 toast（用于「已经在运行」提示）
   —— 防闪烁要点 ——
   ① 页面没画完就 show()，会先出一帧空白再补内容（第一次闪）；
   ② show() 之后才应用位置，会先出现在旧位置再跳过去（第二次闪）。
   所以：等页面就绪 → 定位 → 再显示，且只在不可见时 show。 */
function showPanel(message){
  if (!win) createWindow();
  clearTimeout(blurTimer);
  ignoreBlurUntil = Date.now() + (message ? 1200 : 300);   // 只挡托盘点击那一下的瞬时 blur

  const doShow = () => {
    if (!win || win.isDestroyed()) return;
    positionWindow();                       // 先定位
    logLine(`showPanel 执行 visible=${win.isVisible()} opacity=1`);
    if (!win.isVisible()) win.show();       // 首次才需要 show，之后窗口一直存在
    win.setIgnoreMouseEvents(false);        // 恢复接收鼠标
    win.setOpacity(1);                      // 从透明拨到可见，一帧到位
    panelVisible = true;
    win.focus();
    if (!message) return;
    win.webContents
      .executeJavaScript(`if (typeof toast === 'function') toast(${JSON.stringify(message)});`, true)
      .catch(() => {});
  };

  // 首帧未绘制完就等 ready-to-show，否则先出一帧空白（第一次闪）
  if (!firstPaintReady){
    win.once('ready-to-show', () => { firstPaintReady = true; doShow(); });
    return;
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', doShow);
  else doShow();
}

/* ---------- 开机自启动 ----------
   坑：portable（单文件 exe）每次运行会解压到临时目录，process.execPath 指向那个临时路径，
   拿它去注册开机启动 → 重启后路径不存在，表现为「开了但没生效」。
   electron-builder 的 portable 会注入 PORTABLE_EXECUTABLE_FILE，指向原始的 exe，
   必须优先用它。 */
function autoStartExePath(){
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function setupAutoStart(){
  ipcMain.handle('autostart:get', () => {
    try{
      const p = autoStartExePath();
      const s = app.getLoginItemSettings({ path: p });
      return { ok: true, enabled: !!s.openAtLogin, path: p, portable: !!process.env.PORTABLE_EXECUTABLE_FILE };
    }catch(err){ return { ok: false, error: String(err && err.message || err) }; }
  });

  ipcMain.handle('autostart:set', (e, on) => {
    try{
      const p = autoStartExePath();
      app.setLoginItemSettings({ openAtLogin: !!on, path: p, args: [] });
      // 立刻回读，确认系统真的记下了（写失败时这里会露馅）
      const s = app.getLoginItemSettings({ path: p });
      return { ok: true, enabled: !!s.openAtLogin, path: p, portable: !!process.env.PORTABLE_EXECUTABLE_FILE };
    }catch(err){ return { ok: false, error: String(err && err.message || err) }; }
  });
}

function startApp(){
app.whenReady().then(() => {
  try { fs.writeFileSync(LOG_FILE, ''); } catch (e) {}
  setupHid();
  createWindow();
  setupAutoStart();

  const iconPath = path.join(__dirname, 'assets', 'tray-32.png');
  const img = nativeImage.createFromPath(iconPath);
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('ATK-Light · 未连接');
  tray.on('click', toggle);
  // 首次启动直接把面板弹出来（之后点托盘图标切换）
  // 统一走 showPanel，别在这里另起一套 show 逻辑（重复入口会导致首帧闪烁）
  setTimeout(() => showPanel(null), 400);
  tray.on('right-click', () => {
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: '打开面板', click: toggle },
      { label: '打开设置', click: () => {
        showPanel(null);
        /* 用 IPC 而不是 executeJavaScript：窗口刚创建时 loadFile 还没完成，
           直接点按钮会静默失败。渲染层加载好后自己监听这个事件。 */
        if (win && win.webContents) win.webContents.send('panel-open-settings');
      } },
      { type: 'separator' },
      { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
  });
});

app.on('window-all-closed', (e) => { e.preventDefault && e.preventDefault(); });
app.on('before-quit', () => { app.isQuitting = true; });
}

/* ---------- 单实例：只允许跑一个 ----------
   第二次启动（双击 exe / 再点快捷方式）时：
   · 新进程拿不到锁 → 立刻退出，不会出现第二个托盘图标和第二个面板；
   · 已有实例收到 second-instance 事件 → 把面板弹出来，并提示「已经在运行了」。 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showPanel('ATK-Light 已经在运行了');
  });
  startApp();
}
