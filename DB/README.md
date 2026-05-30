# RP-Hub R2 同步版

这个文件夹是一套独立的 R2 同步代码，不会修改当前项目。

## 部署方式

支持两种部署方式：

### Cloudflare Workers（推荐）

```bash
npx wrangler deploy
```

配置文件 `wrangler.toml`，Worker 入口为 `src/index.js`。

### Cloudflare Pages Advanced Mode

将 `_worker.js` 放在 Pages 项目输出目录根下即可。

## Cloudflare 绑定

必须绑定：

- R2 Bucket：`RP_SYNC_R2`

可选绑定：

- 文本/机密变量：`RP_SYNC_PASSWORD`

不需要绑定 D1。这个版本的 Worker 不包含 D1 建表、查询或写入逻辑。

## R2 优化方式

- 前端把完整浏览器快照切成固定 5MiB 分片。
- 分片按 UTF-8 字节切割并用 base64 传输，避免中文、emoji 造成字符长度和字节长度不一致。
- 上传前先把本地分片 checksum 发给服务器。
- Worker 读取 R2 当前 manifest，只要求前端上传变动分片。
- 提交时使用 Cloudflare R2 官方 multipart upload。
- 没变的分片由 Worker 从旧 R2 快照对象按 range 读取，再作为 multipart part 写入新快照，避免浏览器重复上传。
- 下载统一走 R2 range 分段读取，每段直接返回原始二进制，避免 base64 和大 JSON 导致 503。
- 前端和服务端单次同步快照上限均为 512MiB。

## 文件说明

- `src/index.js`：Cloudflare Workers 入口文件。
- `work.js`：R2 Worker 源码，内容与 `src/index.js` 相同。
- `_worker.js`：Cloudflare Pages Advanced Mode 入口，内容与 `work.js` 相同。
- `wrangler.toml`：Cloudflare Workers 配置文件。
- `DB/bootstrap.js`：前端同步按钮、密码、上传下载逻辑，R2 版使用固定 5MiB 分片。
- `DB/styles.css`：同步按钮和弹窗样式。
- `DB/schema.sql`：仅说明 R2 版不使用 D1。
