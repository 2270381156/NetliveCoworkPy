'use strict';

// POST a single zipped log archive as multipart/form-data to {endpoint}/logs.
// Failures are swallowed (return false): archives are too large for the 200-item
// event queue; requested uploads retry on the next poll, crash uploads on the next
// crash. The file field stays 'files' (server accepts files[], one part is fine).
// FormData/Blob are Node 18+ globals; injected here for tests.
// logFn(可选)：失败时收到一行原因(HTTP 状态码 / 异常),供调用方写日志。
// 返回值仍是布尔(调用方与测试依赖),原因只经 logFn 旁路输出,不改契约。
async function uploadLogs({
  endpoint, fields, archive,
  fetchImpl = fetch, FormDataImpl = FormData, BlobImpl = Blob, logFn,
}) {
  try {
    const form = new FormDataImpl();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) form.append(k, String(v));
    }
    form.append('files', new BlobImpl([archive.data], { type: 'application/zip' }), archive.name);
    const res = await fetchImpl(`${endpoint}/logs`, { method: 'POST', body: form });
    if (!(res && res.ok)) {
      if (logFn) logFn(`POST ${endpoint}/logs -> HTTP ${res ? res.status : 'no-response'}`);
      return false;
    }
    return true;
  } catch (e) {
    if (logFn) logFn(`POST ${endpoint}/logs failed: ${(e && e.message) || e}`);
    return false;
  }
}

module.exports = { uploadLogs };
