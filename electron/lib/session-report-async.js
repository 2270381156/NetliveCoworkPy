'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const { buildSessionReportZip } = require('./session-report-build');

// 打包后代码在 app.asar 里，Worker 直接以文件路径启动脚本在 asar 下不保险；
// 改成 eval 一段引导代码、由它按绝对路径 require 真正的模块(require 走 asar 是
// 稳的)。workerData 只带可序列化字段。
const BOOTSTRAP = `
const { parentPort, workerData } = require('worker_threads');
const { buildSessionReportZip } = require(workerData.buildModule);
const o = workerData.opts;
const sqliteBuf = Buffer.from(o.sqliteBuf.buffer, o.sqliteBuf.byteOffset, o.sqliteBuf.byteLength);
parentPort.postMessage(buildSessionReportZip({ ...o, sqliteBuf }));
`;

function runInWorker(opts) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(BOOTSTRAP, {
        eval: true,
        workerData: { buildModule: path.join(__dirname, 'session-report-build.js'), opts },
      });
    } catch (e) { reject(e); return; }
    let done = false;
    const settle = (fn, v) => { if (!done) { done = true; fn(v); } };
    worker.once('message', (zip) => { settle(resolve, Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength)); worker.terminate(); });
    worker.once('error', (e) => settle(reject, e));
    worker.once('exit', () => settle(reject, new Error('worker exited without a result')));
  });
}

// 在工作线程里打包，主进程不卡。线程起不来/挂了就退回主线程同步跑一遍——
// 上报是用户明确点的，宁可卡一下也别丢。
async function buildSessionReportZipAsync(opts, { logFn = () => {} } = {}) {
  try {
    return await runInWorker(opts);
  } catch (e) {
    logFn(`worker unavailable, zipping on the main thread — ${String((e && e.message) || e)}`);
    return buildSessionReportZip(opts);
  }
}

module.exports = { buildSessionReportZipAsync };
