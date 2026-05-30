const DATASET_ID = 'main';
const R2_BINDING = 'RP_SYNC_R2';
const SYNC_PASSWORD_ENV = 'RP_SYNC_PASSWORD';
const SYNC_PASSWORD_HEADER = 'x-rp-sync-password';
const R2_PREFIX = `rp-sync/${DATASET_ID}`;
const MANIFEST_KEY = `${R2_PREFIX}/manifest.json`;
const SNAPSHOT_PART_SIZE = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_CHUNK_COUNT = 2048;
const MAX_BATCH_CHUNKS = 1;

const INJECTED_BOOTSTRAP = `
<link rel="stylesheet" href="/DB/styles.css?v=r2-5">
<script src="/DB/bootstrap.js?v=r2-5"></script>
`;

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store'
        }
    });
}

function error(message, status = 400, extra = {}) {
    return json({ ok: false, error: message, ...extra }, status);
}

function shouldInject(pathname) {
    return pathname === '/' || pathname === '/index.html';
}

async function sha256Text(text) {
    return sha256Bytes(new TextEncoder().encode(text));
}

async function sha256Bytes(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function getSyncPassword(env) {
    const password = env?.[SYNC_PASSWORD_ENV];
    return typeof password === 'string' && password.length > 0 ? password : '';
}

async function timingSafeTextEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const [leftHash, rightHash] = await Promise.all([sha256Text(left), sha256Text(right)]);
    return leftHash === rightHash;
}

async function isRequestAuthorized(request, env) {
    const expectedPassword = getSyncPassword(env);
    if (!expectedPassword) return true;
    const providedPassword = request.headers.get(SYNC_PASSWORD_HEADER) || '';
    if (!providedPassword) return false;
    return timingSafeTextEqual(providedPassword, expectedPassword);
}

async function handleAuthStatus(request, env) {
    const authRequired = Boolean(getSyncPassword(env));
    const authenticated = !authRequired || await isRequestAuthorized(request, env);
    return json({ ok: true, authRequired, authenticated });
}

function getBucket(env) {
    const bucket = env?.[R2_BINDING];
    if (bucket && typeof bucket.get === 'function' && typeof bucket.put === 'function' && typeof bucket.createMultipartUpload === 'function') {
        return bucket;
    }
    throw new Error('Missing R2 binding: RP_SYNC_R2');
}

function sanitizeDeviceId(value) {
    if (typeof value !== 'string') return 'unknown-device';
    const trimmed = value.trim();
    return trimmed.slice(0, 128) || 'unknown-device';
}

function sanitizeSessionId(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return /^[a-zA-Z0-9_-]{8,128}$/.test(trimmed) ? trimmed : null;
}

function snapshotKey(version) {
    return `${R2_PREFIX}/snapshots/${version}.json`;
}

function uploadManifestKey(sessionId) {
    return `${R2_PREFIX}/uploads/${sessionId}/manifest.json`;
}

async function readR2Json(bucket, key) {
    const object = await bucket.get(key);
    if (!object) return null;
    try {
        return JSON.parse(await object.text());
    } catch (err) {
        throw new Error('R2 JSON 数据已损坏。');
    }
}

function normalizeChunkManifest(manifest) {
    if (!Array.isArray(manifest) || manifest.length === 0 || manifest.length > MAX_CHUNK_COUNT) return null;
    let byteOffset = 0;
    return manifest.map((item, index) => {
        const chunkIndex = Number(item?.index);
        const checksum = typeof item?.checksum === 'string' ? item.checksum : '';
        const length = Number(item?.length);
        const encoding = item?.encoding === 'base64-bytes' ? 'base64-bytes' : '';
        if (!Number.isInteger(chunkIndex) || chunkIndex !== index) throw new Error('分片顺序异常：第 ' + index + ' 片。');
        if (!checksum || checksum.length > 128) throw new Error('分片校验码异常：第 ' + index + ' 片。');
        if (!Number.isInteger(length) || length < 0 || length > SNAPSHOT_PART_SIZE) throw new Error('分片字节大小异常：第 ' + index + ' 片 ' + length + '。');
        if (encoding !== 'base64-bytes') throw new Error('分片编码异常：第 ' + index + ' 片。');
        if (index < manifest.length - 1 && length !== SNAPSHOT_PART_SIZE) throw new Error('R2 multipart 要求除最后一片外都必须是 5MiB 字节：第 ' + index + ' 片。');
        const normalized = { index, checksum, length, byteOffset, byteLength: length, encoding };
        byteOffset += length;
        return normalized;
    });
}

function normalizeChunkBatch(chunks) {
    if (!Array.isArray(chunks) || chunks.length === 0 || chunks.length > MAX_BATCH_CHUNKS) return null;
    return chunks.map((item) => {
        const index = Number(item?.index);
        const payload = typeof item?.payload === 'string' ? item.payload : '';
        const checksum = typeof item?.checksum === 'string' ? item.checksum : '';
        const bytes = base64ToBytes(payload);
        if (!Number.isInteger(index) || index < 0) throw new Error('上传分片序号异常。');
        if (!checksum || checksum.length > 128) throw new Error('上传分片校验码异常：第 ' + index + ' 片。');
        if (bytes.byteLength > SNAPSHOT_PART_SIZE) throw new Error('上传分片过大：第 ' + index + ' 片。');
        return { index, payload, bytes, checksum, length: bytes.byteLength };
    });
}

function normalizeManifest(value) {
    if (!value || typeof value !== 'object') return null;
    const version = Number(value.version);
    const chunkCount = Number(value.chunkCount);
    const totalBytes = Number(value.totalBytes);
    const chunkManifest = Array.isArray(value.chunkManifest) ? value.chunkManifest : [];
    if (!Number.isInteger(version) || version <= 0) return null;
    if (!Number.isInteger(chunkCount) || chunkCount <= 0 || chunkCount > MAX_CHUNK_COUNT) return null;
    if (!Number.isInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_TOTAL_BYTES) return null;
    if (chunkManifest.length !== chunkCount) return null;
    if (typeof value.checksum !== 'string' || !value.checksum) return null;
    if (typeof value.snapshotKey !== 'string' || !value.snapshotKey) return null;
    return {
        version,
        checksum: value.checksum,
        updatedAt: Number(value.updatedAt || 0),
        recordCount: Number(value.recordCount || 0),
        totalBytes,
        chunkCount,
        lastDeviceId: value.lastDeviceId || null,
        snapshotKey: value.snapshotKey,
        chunkManifest
    };
}

async function getManifest(bucket) {
    return normalizeManifest(await readR2Json(bucket, MANIFEST_KEY));
}

function buildRemoteInfo(manifest, extra = {}) {
    return {
        version: manifest.version,
        checksum: manifest.checksum,
        updatedAt: manifest.updatedAt,
        recordCount: manifest.recordCount,
        totalBytes: manifest.totalBytes,
        chunkCount: manifest.chunkCount,
        lastDeviceId: manifest.lastDeviceId,
        ...extra
    };
}

async function handleStatus(bucket) {
    const manifest = await getManifest(bucket);
    return json({ ok: true, remote: manifest ? buildRemoteInfo(manifest) : null });
}

async function handlePullJsonPart(bucket, body) {
    const manifest = await getManifest(bucket);
    if (!manifest) return error('No remote data.', 404);
    const version = Number(body.version);
    const start = Number(body.start);
    const count = Number(body.count);
    if (!Number.isInteger(version) || version !== manifest.version) return error('Remote version changed. Please retry.', 409);
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count !== 1) return error('Invalid pull range.');
    if (start >= manifest.chunkCount || start + count > manifest.chunkCount) return error('Invalid pull range.');

    const firstChunk = manifest.chunkManifest[start];
    const selectedChunks = manifest.chunkManifest.slice(start, start + count);
    const offset = Number(firstChunk.byteOffset);
    const byteLength = selectedChunks.reduce((sum, item) => sum + Number(item.byteLength || item.length || 0), 0);
    if (!Number.isFinite(offset) || !Number.isFinite(byteLength) || byteLength <= 0) return error('R2 分段字节信息异常。', 409);
    const object = await bucket.get(manifest.snapshotKey, { range: { offset, length: byteLength } });
    if (!object) return error('R2 快照分段不存在。', 404);
    return new Response(object.body, {
        status: 200,
        headers: {
            'content-type': 'application/octet-stream',
            'cache-control': 'no-store',
            'x-rp-sync-start': String(start),
            'x-rp-sync-count': String(count),
            'x-rp-sync-byte-length': String(byteLength)
        }
    });
}

async function handlePushManifest(bucket, body) {
    const sessionId = sanitizeSessionId(body.sessionId);
    const deviceId = sanitizeDeviceId(body.deviceId);
    const checksum = typeof body.checksum === 'string' ? body.checksum : '';
    const recordCount = Number.isFinite(Number(body.recordCount)) ? Number(body.recordCount) : 0;
    const chunkCount = Number.isFinite(Number(body.chunkCount)) ? Number(body.chunkCount) : 0;
    const totalBytes = Number.isFinite(Number(body.totalBytes)) ? Number(body.totalBytes) : 0;
    if (!sessionId) return error('同步会话无效，请刷新页面后重试。');
    if (!checksum) return error('本地数据校验码为空，请刷新页面后重试。');
    if (chunkCount <= 0 || chunkCount > MAX_CHUNK_COUNT) return error(`本地数据分片数量异常：${chunkCount}/${MAX_CHUNK_COUNT}。`);
    if (totalBytes <= 0 || totalBytes > MAX_TOTAL_BYTES) return error(`本地数据太大：${totalBytes}/${MAX_TOTAL_BYTES}。`);

    let chunkManifest;
    try {
        chunkManifest = normalizeChunkManifest(body.chunkManifest);
    } catch (err) {
        return error(err instanceof Error ? err.message : '分片清单无效。');
    }
    if (!chunkManifest || chunkManifest.length !== chunkCount) return error('分片清单数量不一致。');
    const manifestTotalBytes = chunkManifest.reduce((sum, item) => sum + item.length, 0);
    if (manifestTotalBytes !== totalBytes) return error('分片大小合计不一致。');

    const current = await getManifest(bucket);
    const nextVersion = (current?.version || 0) + 1;
    const key = snapshotKey(nextVersion);
    const multipart = await bucket.createMultipartUpload(key, {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: { dataset: DATASET_ID, checksum, sessionId }
    });

    const missingIndices = [];
    for (const item of chunkManifest) {
        const currentItem = current?.chunkManifest?.[item.index];
        if (!current || !currentItem || currentItem.checksum !== item.checksum || Number(currentItem.length) !== item.length) {
            missingIndices.push(item.index);
        }
    }

    const upload = {
        sessionId,
        uploadId: multipart.uploadId,
        key,
        checksum,
        recordCount,
        chunkCount,
        totalBytes,
        chunkManifest,
        uploadedParts: [],
        missingIndices,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deviceId,
        previous: current ? { version: current.version, snapshotKey: current.snapshotKey, chunkCount: current.chunkCount } : null
    };
    await bucket.put(uploadManifestKey(sessionId), JSON.stringify(upload), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });

    return json({ ok: true, sessionId, missingIndices, acceptedChunkCount: chunkCount });
}

async function getUpload(bucket, sessionId) {
    const upload = await readR2Json(bucket, uploadManifestKey(sessionId));
    if (!upload || upload.sessionId !== sessionId || !upload.uploadId || !upload.key || !Array.isArray(upload.chunkManifest)) return null;
    upload.uploadedParts = Array.isArray(upload.uploadedParts) ? upload.uploadedParts : [];
    upload.missingIndices = Array.isArray(upload.missingIndices) ? upload.missingIndices : [];
    return upload;
}

async function handlePushChunks(bucket, body) {
    const sessionId = sanitizeSessionId(body.sessionId);
    if (!sessionId) return error('同步会话无效，请刷新页面后重试。');
    const upload = await getUpload(bucket, sessionId);
    if (!upload) return error('Upload session not found.', 404);

    let chunks;
    try {
        chunks = normalizeChunkBatch(body.chunks);
    } catch (err) {
        return error(err instanceof Error ? err.message : '上传分片无效。');
    }
    if (!chunks) return error('上传分片为空或单次上传数量过多。');

    const multipart = bucket.resumeMultipartUpload(upload.key, upload.uploadId);
    const uploadedPartMap = new Map(upload.uploadedParts.map((part) => [Number(part.partNumber), part]));
    for (const chunk of chunks) {
        const manifestItem = upload.chunkManifest[chunk.index];
        if (!manifestItem) return error('Invalid chunk index.', 400);
        if (!upload.missingIndices.includes(chunk.index)) return error('该分片不需要上传。', 409, { chunkIndex: chunk.index });
        if (manifestItem.checksum !== chunk.checksum || Number(manifestItem.length) !== chunk.length) {
            return error('上传分片元数据不一致。', 409, { chunkIndex: chunk.index });
        }
        if (await sha256Bytes(chunk.bytes) !== chunk.checksum) {
            return error('上传分片校验失败。', 409, { chunkIndex: chunk.index });
        }
        const part = await multipart.uploadPart(chunk.index + 1, chunk.bytes);
        uploadedPartMap.set(part.partNumber, { ...part, index: chunk.index, byteLength: chunk.length });
    }

    const uploadedParts = Array.from(uploadedPartMap.values()).sort((a, b) => a.partNumber - b.partNumber);
    const uploadedNumbers = new Set(uploadedParts.map((part) => Number(part.partNumber)));
    const missingIndices = upload.missingIndices.filter((index) => !uploadedNumbers.has(index + 1));
    await bucket.put(uploadManifestKey(sessionId), JSON.stringify({ ...upload, uploadedParts, missingIndices, updatedAt: Date.now() }), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' }
    });

    return json({ ok: true, sessionId, missingIndices });
}

async function copyUnchangedParts(bucket, upload, uploadedPartMap) {
    if (!upload.previous?.snapshotKey) return;
    const multipart = bucket.resumeMultipartUpload(upload.key, upload.uploadId);
    for (let index = 0; index < upload.chunkCount; index += 1) {
        const partNumber = index + 1;
        if (uploadedPartMap.has(partNumber)) continue;
        const chunkMeta = upload.chunkManifest[index];
        const offset = Number(chunkMeta.byteOffset);
        const byteLength = Number(chunkMeta.byteLength);
        if (!Number.isFinite(offset) || !Number.isFinite(byteLength) || byteLength <= 0) throw new Error(`服务器旧分片字节信息缺失：${index}`);
        const object = await bucket.get(upload.previous.snapshotKey, { range: { offset, length: byteLength } });
        if (!object) throw new Error(`服务器旧分片缺失：${index}`);
        const bytes = new Uint8Array(await object.arrayBuffer());
        if (bytes.byteLength !== byteLength || await sha256Bytes(bytes) !== String(chunkMeta.checksum)) {
            throw new Error('服务器旧分片校验失败：' + index);
        }
        const part = await multipart.uploadPart(partNumber, bytes);
        uploadedPartMap.set(part.partNumber, { ...part, index, byteLength });
    }
}

async function handlePushCommit(bucket, body) {
    const sessionId = sanitizeSessionId(body.sessionId);
    if (!sessionId) return error('同步会话无效，请刷新页面后重试。');
    const upload = await getUpload(bucket, sessionId);
    if (!upload) return error('Upload session not found.', 404);

    const uploadedPartMap = new Map(upload.uploadedParts.map((part) => [Number(part.partNumber), part]));
    try {
        await copyUnchangedParts(bucket, upload, uploadedPartMap);
    } catch (err) {
        return error(err instanceof Error ? err.message : '复制未变分片失败。', 409);
    }

    for (let index = 0; index < upload.chunkCount; index += 1) {
        if (!uploadedPartMap.has(index + 1)) return error('Upload incomplete.', 409, { missingChunkIndex: index });
    }

    const multipart = bucket.resumeMultipartUpload(upload.key, upload.uploadId);
    const parts = Array.from(uploadedPartMap.values()).sort((a, b) => a.partNumber - b.partNumber);
    let nextByteOffset = 0;
    const committedChunkManifest = upload.chunkManifest.map((item, index) => {
        const part = uploadedPartMap.get(index + 1);
        const byteLength = Number(part?.byteLength);
        if (!Number.isFinite(byteLength) || byteLength <= 0) throw new Error(`分片字节信息缺失：${index}`);
        const nextItem = { ...item, byteOffset: nextByteOffset, byteLength };
        nextByteOffset += byteLength;
        return nextItem;
    });
    const object = await multipart.complete(parts);
    if (!object) return error('R2 multipart complete failed.', 409);
    if (object.size !== nextByteOffset) return error('R2 快照大小校验失败。', 409);

    const updatedAt = Date.now();
    const committedManifest = {
        version: Number((await getManifest(bucket))?.version || 0) + 1,
        checksum: String(upload.checksum),
        updatedAt,
        recordCount: Number(upload.recordCount || 0),
        totalBytes: Number(upload.totalBytes),
        chunkCount: Number(upload.chunkCount),
        lastDeviceId: upload.deviceId || 'unknown-device',
        snapshotKey: upload.key,
        chunkManifest: committedChunkManifest,
        mode: 'r2-multipart-snapshot-v1'
    };
    await bucket.put(MANIFEST_KEY, JSON.stringify(committedManifest), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });

    const cleanupKeys = [uploadManifestKey(sessionId)];
    if (upload.previous?.snapshotKey && upload.previous.snapshotKey !== upload.key) cleanupKeys.push(upload.previous.snapshotKey);
    await bucket.delete(cleanupKeys);

    return json({ ok: true, version: committedManifest.version, checksum: committedManifest.checksum, updatedAt });
}

async function handleApi(request, env) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: { allow: 'POST, OPTIONS' } });
    }
    if (request.method !== 'POST') return error('Method not allowed.', 405);

    const body = await request.json();
    if (!body || typeof body !== 'object') return error('Invalid JSON body.');
    if (body.action === 'auth-status') return handleAuthStatus(request, env);
    if (!await isRequestAuthorized(request, env)) return error('Sync password required.', 401, { authRequired: true });

    const bucket = getBucket(env);
    if (body.action === 'pull-manifest' || body.action === 'status') return handleStatus(bucket);
    if (body.action === 'pull-json-part') return handlePullJsonPart(bucket, body);
    if (body.action === 'push-manifest') return handlePushManifest(bucket, body);
    if (body.action === 'push-chunks') return handlePushChunks(bucket, body);
    if (body.action === 'push-commit') return handlePushCommit(bucket, body);
    return error('Unsupported action.', 404);
}

async function serveStatic(request, env) {
    if (!env?.ASSETS || typeof env.ASSETS.fetch !== 'function') {
        throw new Error('Missing ASSETS binding. Workers Static Assets requires env.ASSETS.fetch(request).');
    }
    const response = await env.ASSETS.fetch(request);
    const pathname = new URL(request.url).pathname;
    const contentType = response.headers.get('content-type') || '';
    if (!shouldInject(pathname) || !contentType.includes('text/html')) return response;
    return new HTMLRewriter().on('head', {
        element(element) {
            element.append(INJECTED_BOOTSTRAP, { html: true });
        }
    }).transform(response);
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === '/api/rp-sync') {
            try {
                return await handleApi(request, env);
            } catch (err) {
                return error(err instanceof Error ? err.message : 'Unexpected server error.', 500);
            }
        }
        return serveStatic(request, env);
    }
};
