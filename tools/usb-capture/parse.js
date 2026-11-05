// 解析 USBPcap pcap，提取 ATK 命令帧并做结构分析
//
// 用法：
//   node parse.js out.pcap                列出帧（去重）
//   node parse.js out.pcap --fields       按「地址」聚合，标出「值+补码」结构
//   node parse.js --diff 前.pcap 后.pcap   对比两次抓包，列出变化的地址和字节
//
// 设计意图：不告诉你「哪个地址是 LOD」，只把「改一处之后，哪里变了」自动标出来。
// 这是「改一处、看哪里变」的手工流程的自动化版本。
const fs = require('fs');

const CMD_NAME = {
  3: '在线', 4: '电量', 7: '写EEPROM', 8: '读EEPROM', 10: '上报',
  14: '配置', 16: 'CIDMID', 18: '版本', 22: '远距写', 23: '远距',
  29: '接收器版本',
};

function loadFrames(file) {
  const buf = fs.readFileSync(file);
  const le = buf.readUInt32LE(0) === 0xa1b2c3d4;
  if (!le && buf.readUInt32BE(0) !== 0xa1b2c3d4) throw new Error('不是 pcap 文件: ' + file);
  const rd16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const rd32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));

  const linkType = buf.readUInt32LE(20);
  let off = 24;
  let packets = 0;
  const frames = [];

  while (off + 16 <= buf.length) {
    const inclLen = buf.readUInt32LE(off + 8);
    const dataStart = off + 16;
    if (dataStart + inclLen > buf.length) break;
    const tsSec = buf.readUInt32LE(off);
    const tsUsec = buf.readUInt32LE(off + 4);
    off = dataStart + inclLen;
    packets++;

    const headerLen = rd16(dataStart);
    const hEnd = dataStart + headerLen;
    if (headerLen < 20 || hEnd > dataStart + inclLen) continue;

    const dataLength = rd32(hEnd - 4);
    const endpoint = buf[dataStart + 21] || 0;
    const transfer = buf[dataStart + 22] || 0;
    const payload = buf.slice(hEnd, Math.min(hEnd + dataLength, dataStart + inclLen));

    for (let i = 0; i + 17 <= payload.length; i++) {
      if (payload[i] !== 0x08) continue;
      const f = payload.slice(i + 1, i + 17);
      let sum = 8;
      for (let k = 0; k < 15; k++) sum += f[k];
      if (((0x55 - (sum & 0xff)) & 0xff) !== f[15]) continue;
      frames.push({
        t: tsSec + tsUsec / 1e6,
        ep: endpoint,
        tr: transfer,
        dir: (endpoint & 0x80) ? 'IN' : 'OUT',
        cmd: f[0],
        name: CMD_NAME[f[0]] || '?',
        addr: f[2] | (f[3] << 8),
        len: f[4],
        data: Array.from(f.slice(5, 15)),
        hex: Array.from(f).map((b) => b.toString(16).padStart(2, '0')).join(' '),
      });
    }
  }
  return { linkType, packets, frames, file };
}

const hex2 = (n) => n.toString(16).padStart(2, '0');

/* 标出「值 + 补码」成对结构：相邻两字节之和为常量（这里试 0x55 及其它常见值） */
function pairHints(bytes) {
  /* 贪心匹配：一个字节只属于一对。
     否则 [0]+[1] 配对成功后，[1]+[2] 常因为 [2] 恰好是下一个值的开头而误报。 */
  const hints = [];
  let i = 0;
  while (i + 1 < bytes.length) {
    const s = bytes[i] + bytes[i + 1];
    if (s === 0x55 || s === 0xaa || s === 0xff || s === 0x100) {
      hints.push(`[${i}]+[${i + 1}]=0x${s.toString(16)}`);
      i += 2;
    } else {
      i += 1;
    }
  }
  return hints;
}

/* 模式 1：列帧 */
function modeList(file) {
  const { linkType, packets, frames } = loadFrames(file);
  console.log(`linkType=${linkType} | pcap 包数: ${packets} | 命中 ATK 帧: ${frames.length}`);
  if (!frames.length) return;

  const t0 = frames[0].t;
  const seen = new Set();
  let shown = 0;
  for (const f of frames) {
    const key = f.hex + f.dir;
    if (seen.has(key)) continue;
    seen.add(key);
    if (shown++ > 120) break;
    const addr = f.addr ? ' addr=0x' + f.addr.toString(16).toUpperCase().padStart(4, '0') : '';
    console.log(
      `+${(f.t - t0).toFixed(2)}s ${f.dir.padEnd(3)} ep=0x${f.ep.toString(16)} tr=${f.tr} ` +
      `cmd=${String(f.cmd).padStart(2, '0')} ${f.name}${addr} len=${f.len}  ${f.hex}`
    );
  }
  console.log(`唯一帧: ${seen.size} / 总命中: ${frames.length}`);
}

/* 模式 2：按地址聚合 */
function modeFields(file) {
  const { frames } = loadFrames(file);
  /* 只看读 EEPROM（cmd=8）且有长度的帧——这类才是「配置快照」 */
  const reads = frames.filter((f) => f.cmd === 8 && f.len > 0 && f.dir === 'IN');
  if (!reads.length) {
    console.log('没有读到配置帧（cmd=8）。建议在抓包时打开官方 HUB 的配置页，让它把参数读一遍。');
    return;
  }

  const byAddr = new Map();
  for (const f of reads) {
    const key = f.addr;
    const bytes = f.data.slice(0, Math.min(f.len, 10));
    if (!byAddr.has(key)) byAddr.set(key, { len: f.len, values: new Map() });
    const slot = byAddr.get(key);
    const sig = bytes.map(hex2).join(' ');
    slot.values.set(sig, (slot.values.get(sig) || 0) + 1);
  }

  const addrs = [...byAddr.keys()].sort((a, b) => a - b);
  console.log(`共 ${addrs.length} 个地址，${reads.length} 条读帧\n`);

  for (const a of addrs) {
    const slot = byAddr.get(a);
    const vals = [...slot.values.entries()];
    console.log(`0x${a.toString(16).toUpperCase().padStart(4, '0')}  len=${slot.len}  出现 ${vals.reduce((s, v) => s + v[1], 0)} 次`);

    for (const [sig, cnt] of vals.slice(0, 4)) {
      const bytes = sig.split(' ').map((h) => parseInt(h, 16));
      console.log(`  值(${cnt}次): ${sig}`);
      const hints = pairHints(bytes);
      if (hints.length) console.log(`    结构: ${hints.join('  ')}  ← 相邻和为常数，可能是「值+补码」`);
    }
    if (vals.length > 4) console.log(`  …另有 ${vals.length - 4} 种不同取值`);
    console.log('');
  }

  console.log('提示：以上只列出「读到了什么」，不代表字段含义。');
  console.log('      想知道某个设置对应哪个地址，用 --diff 对比「改设置前后」两次抓包。');
}

/* 模式 3：对比两次抓包 */
function modeDiff(fileA, fileB) {
  const A = loadFrames(fileA);
  const B = loadFrames(fileB);

  const snap = (frames) => {
    const m = new Map();
    for (const f of frames) {
      if (f.cmd !== 8 || f.len <= 0 || f.dir !== 'IN') continue;
      const bytes = f.data.slice(0, Math.min(f.len, 10));
      /* 同一地址取最后一次读到的值（最接近"最终状态"） */
      m.set(f.addr, { len: f.len, bytes });
    }
    return m;
  };

  const a = snap(A.frames);
  const b = snap(B.frames);

  console.log(`对比：\n  A(前) ${fileA}  →  ${a.size} 个地址\n  B(后) ${fileB}  →  ${b.size} 个地址\n`);

  const common = [...a.keys()].filter((k) => b.has(k)).sort((x, y) => x - y);
  if (!common.length) {
    console.log('两次抓包里没有共同地址——可能是不同的配置页/设备，无法对比。');
    return;
  }

  let changed = 0;
  for (const addr of common) {
    const va = a.get(addr);
    const vb = b.get(addr);
    const n = Math.min(va.bytes.length, vb.bytes.length);
    const diffs = [];
    for (let i = 0; i < n; i++) {
      if (va.bytes[i] !== vb.bytes[i]) diffs.push(i);
    }
    if (!diffs.length) continue;

    changed++;
    const label = `0x${addr.toString(16).toUpperCase().padStart(4, '0')}`;
    console.log(`${label}  有 ${diffs.length} 处变化`);

    const fmt = (arr, from, to) =>
      arr.slice(from, to + 1).map(hex2).join(' ');

    for (const i of diffs.slice(0, 8)) {
      const lo = Math.max(0, i - 1);
      const hi = Math.min(n - 1, i + 1);
      console.log(
        `  [${i}]  ${hex2(va.bytes[i])} → ${hex2(vb.bytes[i])}` +
        `    上下文 A: ${fmt(va.bytes, lo, hi)}   B: ${fmt(vb.bytes, lo, hi)}`
      );
    }
    if (diffs.length > 8) console.log(`  …另有 ${diffs.length - 8} 处`);

    /* 如果变化点旁边正好构成「值+补码」，提示一下 */
    for (const i of diffs.slice(0, 8)) {
      const pivot = (arr) => {
        if (i + 1 < arr.length) return arr[i] + arr[i + 1];
        if (i - 1 >= 0) return arr[i - 1] + arr[i];
        return -1;
      };
      const sa = pivot(va.bytes);
      const sb = pivot(vb.bytes);
      if (sa > 0 && sa === sb) {
        console.log(`       ↳ 该字节与相邻字节之和保持 0x${sa.toString(16)}，符合「值+补码」结构`);
        break;
      }
    }
    console.log('');
  }

  if (!changed) {
    console.log('没有差异。可能是：改的设置走的是「运行时命令」不落 EEPROM，或两次抓的配置页相同。');
  } else {
    console.log(`共 ${changed} 个地址发生变化。`);
    console.log('提示：这些地址里，通常只有 1-2 个对应你改动的那项设置，其余是时间/计数类字段。');
    console.log('      再改一项、再抓一次，交叉对比就能锁定——两次都变的可能不是目标字段。');
  }
}

/* ---------- 入口 ---------- */
const argv = process.argv.slice(2);
if (!argv.length) {
  console.log('用法：');
  console.log('  node parse.js out.pcap                 列帧');
  console.log('  node parse.js out.pcap --fields        按地址聚合 + 结构提示');
  console.log('  node parse.js --diff 前.pcap 后.pcap   对比两次抓包');
  process.exit(0);
}

try {
  if (argv[0] === '--diff') {
    if (argv.length < 3) {
      console.log('用法: node parse.js --diff 前.pcap 后.pcap');
      process.exit(1);
    }
    modeDiff(argv[1], argv[2]);
  } else if (argv.includes('--fields')) {
    modeFields(argv[0]);
  } else {
    modeList(argv[0]);
  }
} catch (e) {
  console.error('解析失败:', e.message);
  console.error('常见原因：文件不是标准 pcap（可能是 pcapng）、录制被截断、或路径不对。');
  process.exit(2);
}
