// 抓 USB 流量（需要管理员）：启动 USBPcapCMD，指定秒数后停止
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEV = process.argv[2] || '\\\\.\\USBPcap1';
const OUT = process.argv[3] || path.join(__dirname, 'usb.pcap');
const SECS = Number(process.argv[4] || 30);

const CMD = 'C:\\Program Files\\USBPcap\\USBPcapCMD.exe';
if (!fs.existsSync(CMD)) { console.log('未安装 USBPcap'); process.exit(2); }

console.log(`开始抓包：${DEV} → ${OUT}（${SECS} 秒）`);
const p = spawn(CMD, ['-d', DEV, '-o', OUT, '-s', '65535', '-A'], { windowsHide: true });

p.stdout.on('data', d => process.stdout.write('[cap] ' + d.toString()));
p.stderr.on('data', d => process.stderr.write('[cap-err] ' + d.toString()));
p.on('error', e => console.log('启动失败:', e.message));

setTimeout(() => {
  try { p.kill('SIGINT'); } catch (e) {}
  setTimeout(() => {
    try { p.kill(); } catch (e) {}
    const ok = fs.existsSync(OUT);
    console.log(ok ? `抓包结束：${(fs.statSync(OUT).size / 1024).toFixed(1)} KB` : '未生成文件');
    process.exit(ok ? 0 : 1);
  }, 800);
}, SECS * 1000);
