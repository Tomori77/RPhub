# RP-Hub R2 同步版

这个文件夹是一套独立的 R2 同步代码，不会修改当前项目。

## Cloudflare 绑定

必须绑定：

- R2 Bucket：`RP_SYNC_R2`

可选绑定：

- 文本/机密变量：`RP_SYNC_PASSWORD`

不需要绑定 D1。这个版本的 Worker 不包含 D1 建表、查询或写入逻辑。

## R2 优化方式

- 只保留手动同步：用户点击后才上传或拉取，不做自动同步、不做多端时间合并。
- 前端把完整浏览器快照切成固定 8MiB 分片，直接用 `application/octet-stream` 上传原始二进制。
- 不再使用 base64 JSON 承载分片，减少约三分之一传输体积，也减少浏览器编码开销。
- Worker 使用 R2 multipart upload；前端持有 `uploadId` 和 part 信息，避免每上传一片就写一次 R2 会话清单。
- 上传前会按 checksum + 字节长度匹配旧快照分片；浏览器只上传变更分片，未变化分片由 Worker 从旧 R2 快照 range 读取后补进新的 multipart 对象。
- R2 multipart 要求除最后一片外所有 part 等长，所以增量复用基于固定大小分片。
- 分片上传支持小并发，仍会逐片校验 SHA-256，避免损坏数据写入 R2。
- 下载继续走 R2 range 分段读取，每段直接返回原始二进制，避免大 JSON 响应导致 503。
- 前端和服务端单次同步快照上限均为 512MiB。

## 文件说明

- `_worker.js`：Cloudflare Pages Advanced Mode 入口，也是实际 Worker 代码。
- `work.js`：兼容入口，只转出 `_worker.js`，避免两份 Worker 代码重复维护。
- `DB/bootstrap.js`：前端同步按钮、密码、上传下载逻辑，R2 版使用固定大小原始二进制分片。
- `DB/styles.css`：同步按钮和弹窗样式。
