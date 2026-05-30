const DATASET_ID = 'main';
const R2_BINDING = 'RP_SYNC_R2';
const SYNC_PASSWORD_ENV = 'RP_SYNC_PASSWORD';
const SYNC_PASSWORD_HEADER = 'x-rp-sync-password';
const API_PATH = '/api/rp-sync';
const R2_PREFIX = `rp-sync/${DATASET_ID}`;
const MANIFEST_KEY = `${R2_PREFIX}/manifest.json`;
const SNAPSHOT_PREFIX = `${R2_PREFIX}/snapshots`;
const MIN_MULTIPART_PART_SIZE = 5 * 1024 * 1024;
const MAX_PART_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_CHUNK_COUNT = 10000;
const MAX_PULL_CHUNKS = 8;
const COPY_REUSED_PART_CONCURRENCY = 3;

const INJECTED_BOOTSTRAP = `
<link rel="stylesheet" href="/DB/styles.css?v=r2-6">
<script src="/DB/bootstrap.js?v=r2-6"></script>
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
    if (
        bucket
        && typeof bucket.get === 'function'
        && typeof bucket.put === 'function'
        && typeof bucket.delete === 'function'
        && typeof bucket.createMultipartUpload === 'function'
        && typeof bucket.resumeMultipartUpload === 'function'
    ) {
        return bucket;
    }
    throw new Error('Missing R2 binding: RP_SYNC_R2');
}

function sanitizeSessionId(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return /^[a-zA-Z0-9_-]{8,160}$/.test(trimmed) ? trimmed : null;
}

function sanitizeSnapshotKey(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.startsWith(`${SNAPSHOT_PREFIX}/`) && trimmed.endsWith('.json') ? trimmed : null;
}

function createSnapshotKey(sessionId) {
    return `${SNAPSHOT_PREFIX}/${Date.now()}-${sessionId}.json`;
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

function buildEmptyRemoteInfo(checksum, recordCount, totalBytes) {
    return {
        version: 0,
        checksum,
        updatedAt: 0,
        recordCount,
        totalBytes,
        chunkCount: 0,
        chunkSize: 0
    };
}

function normalizeChunkManifest(manifest, totalBytes) {
    if (!Array.isArray(manifest) || manifest.length === 0 || manifest.length > MAX_CHUNK_COUNT) return null;

    let byteOffset = 0;
    let standardPartSize = null;
    const normalized = manifest.map((item, index) => {
        const chunkIndex = Number(item?.index);
        const checksum = typeof item?.checksum === 'string' ? item.checksum : '';
        const length = Number(item?.length);

        if (!Number.isInteger(chunkIndex) || chunkIndex !== index) throw new Error(`分片顺序异常：第 ${index} 片。`);
        if (!/^[a-f0-9]{64}$/i.test(checksum)) throw new Error(`分片校验码异常：第 ${index} 片。`);
        if (!Number.isInteger(length) || length <= 0 || length > MAX_PART_BYTES) throw new Error(`分片大小异常：第 ${index} 片。`);

        const isLast = index === manifest.length - 1;
        if (!isLast && length < MIN_MULTIPART_PART_SIZE) throw new Error(`除最后一片外，每片至少需要 5MiB：第 ${index} 片。`);
        if (!isLast) {
            if (standardPartSize === null) standardPartSize = length;
            if (length !== standardPartSize) throw new Error('上传数据格式不正确，请刷新页面后重试。');
        }

        const nextItem = {
            index,
            partNumber: index + 1,
            checksum: checksum.toLowerCase(),
            length,
            byteOffset,
            byteLength: length,
            encoding: 'raw-bytes'
        };
        byteOffset += length;
        return nextItem;
    });

    if (byteOffset !== totalBytes) throw new Error('分片大小合计不一致。');
    return normalized;
}

function normalizeManifest(value) {
    if (!value || typeof value !== 'object') return null;
    const version = Number(value.version);
    const chunkCount = Number(value.chunkCount);
    const totalBytes = Number(value.totalBytes);
    const chunkManifest = Array.isArray(value.chunkManifest) ? value.chunkManifest : [];
    if (!Number.isInteger(version) || version <= 0) return null;
    if (!Number.isInteger(chunkCount) || chunkCount < 0 || chunkCount > MAX_CHUNK_COUNT) return null;
    if (!Number.isInteger(totalBytes) || totalBytes < 0 || totalBytes > MAX_TOTAL_BYTES) return null;
    if (typeof value.checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(value.checksum)) return null;
    if (chunkCount === 0) {
        return {
            version,
            checksum: value.checksum.toLowerCase(),
            updatedAt: Number(value.updatedAt || 0),
            recordCount: Number(value.recordCount || 0),
            totalBytes,
            chunkCount: 0,
            chunkSize: Number(value.chunkSize || 0),
            snapshotKey: value.snapshotKey || '',
            chunkManifest: [],
            mode: value.mode || 'r2-client-multipart-v2'
        };
    }
    if (chunkManifest.length !== chunkCount) return null;
    if (!sanitizeSnapshotKey(value.snapshotKey)) return null;
    return {
        version,
        checksum: value.checksum.toLowerCase(),
        updatedAt: Number(value.updatedAt || 0),
        recordCount: Number(value.recordCount || 0),
        totalBytes,
        chunkCount,
        chunkSize: Number(value.chunkSize || 0),
        snapshotKey: value.snapshotKey,
        chunkManifest,
        mode: value.mode || 'r2-client-multipart-v2'
    };
}

function getChunkLength(chunk) {
    return Number(chunk?.byteLength || chunk?.length || 0);
}

function isSameChunk(left, right) {
    return Boolean(left && right)
        && String(left.checksum || '').toLowerCase() === String(right.checksum || '').toLowerCase()
        && getChunkLength(left) === getChunkLength(right);
}

function chunkSignature(chunk) {
    const checksum = String(chunk?.checksum || '').toLowerCase();
    const length = getChunkLength(chunk);
    return `${checksum}:${length}`;
}

function buildChunkLookup(manifest) {
    const lookup = new Map();
    for (const chunk of Array.isArray(manifest?.chunkManifest) ? manifest.chunkManifest : []) {
        if (chunk?.checksum) {
            lookup.set(chunkSignature(chunk), chunk);
        }
    }
    return lookup;
}

async function getManifest(bucket) {
    return normalizeManifest(await readR2Json(bucket, MANIFEST_KEY));
}

function buildRemoteInfo(manifest) {
    return {
        version: manifest.version,
        checksum: manifest.checksum,
        updatedAt: manifest.updatedAt,
        recordCount: manifest.recordCount,
        totalBytes: manifest.totalBytes,
        chunkCount: manifest.chunkCount,
        chunkSize: manifest.chunkSize
    };
}

async function handleStatus(bucket) {
    const manifest = await getManifest(bucket);
    return json({ ok: true, remote: manifest ? buildRemoteInfo(manifest) : null });
}

async function handlePullJsonPart(bucket, body) {
    const manifest = await getManifest(bucket);
    if (!manifest) return error('服务器当前没有可同步的数据。', 404);

    const version = Number(body.version);
    const start = Number(body.start);
    const count = Number(body.count);
    if (!Number.isInteger(version) || version !== manifest.version) return error('服务器版本已变化，请重试。', 409);
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count <= 0 || count > MAX_PULL_CHUNKS) {
        return error('下载分段范围无效。');
    }
    if (start >= manifest.chunkCount || start + count > manifest.chunkCount) return error('下载分段范围无效。');

    const firstChunk = manifest.chunkManifest[start];
    const selectedChunks = manifest.chunkManifest.slice(start, start + count);
    const offset = Number(firstChunk.byteOffset);
    const byteLength = selectedChunks.reduce((sum, item) => sum + Number(item.byteLength || item.length || 0), 0);
    if (!Number.isFinite(offset) || !Number.isFinite(byteLength) || byteLength <= 0) {
        return error('R2 分段字节信息异常。', 409);
    }

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

async function handleUploadCreate(bucket, body) {
    const sessionId = sanitizeSessionId(body.sessionId);
    const checksum = typeof body.checksum === 'string' ? body.checksum.toLowerCase() : '';
    const recordCount = Number.isFinite(Number(body.recordCount)) ? Number(body.recordCount) : 0;
    const chunkSize = Number.isFinite(Number(body.chunkSize)) ? Number(body.chunkSize) : 0;
    const chunkCount = Number.isFinite(Number(body.chunkCount)) ? Number(body.chunkCount) : 0;
    const totalBytes = Number.isFinite(Number(body.totalBytes)) ? Number(body.totalBytes) : 0;

    if (!sessionId) return error('同步会话无效，请刷新页面后重试。');
    if (!/^[a-f0-9]{64}$/i.test(checksum)) return error('本地数据校验码无效。');
    if (chunkCount === 0 && totalBytes === 0) {
        return json({ ok: true, alreadyUpToDate: true, remote: buildEmptyRemoteInfo(checksum, recordCount, totalBytes) });
    }
    if (!Number.isInteger(chunkCount) || chunkCount <= 0 || chunkCount > MAX_CHUNK_COUNT) return error(`本地数据数量异常：${chunkCount}/${MAX_CHUNK_COUNT}。`);
    if (!Number.isInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_TOTAL_BYTES) return error(`本地数据太大：${totalBytes}/${MAX_TOTAL_BYTES}。`);

    let chunkManifest;
    try {
        chunkManifest = normalizeChunkManifest(body.chunkManifest, totalBytes);
    } catch (err) {
        return error(err instanceof Error ? err.message : '分片清单无效。');
    }
    if (!chunkManifest || chunkManifest.length !== chunkCount) return error('分片清单数量不一致。');

    const current = await getManifest(bucket);
    if (current?.checksum === checksum) {
        return json({ ok: true, alreadyUpToDate: true, remote: buildRemoteInfo(current) });
    }

    const currentChunkLookup = buildChunkLookup(current);
    const missingIndices = [];
    const reusableIndices = [];
    for (const item of chunkManifest) {
        if (isSameChunk(item, currentChunkLookup.get(chunkSignature(item)))) {
            reusableIndices.push(item.index);
        } else {
            missingIndices.push(item.index);
        }
    }

    const key = createSnapshotKey(sessionId);
    let multipart;
    try {
        multipart = await bucket.createMultipartUpload(key, {
            httpMetadata: { contentType: 'application/json; charset=utf-8' },
            customMetadata: { dataset: DATASET_ID, checksum, sessionId }
        });
    } catch (err) {
        return error(err instanceof Error ? err.message : '创建上传任务失败。', 409);
    }

    return json({
        ok: true,
        alreadyUpToDate: false,
        sessionId,
        uploadId: multipart.uploadId,
        key,
        chunkSize,
        chunkCount,
        totalBytes,
        recordCount,
        missingIndices,
        reusableIndices,
        previousVersion: current?.version || 0
    });
}

async function handleUploadPart(request, bucket, url) {
    const uploadId = url.searchParams.get('uploadId') || '';
    const key = sanitizeSnapshotKey(url.searchParams.get('key') || '');
    const partNumber = Number(url.searchParams.get('partNumber'));
    const index = Number(url.searchParams.get('index'));
    const isLastPart = url.searchParams.get('last') === '1';
    const expectedChecksum = (request.headers.get('x-rp-part-checksum') || '').toLowerCase();
    const expectedLength = Number(request.headers.get('x-rp-part-length') || 0);

    if (!uploadId || !key) return error('上传会话无效，请重新上传。');
    if (!Number.isInteger(partNumber) || partNumber <= 0 || partNumber > MAX_CHUNK_COUNT) return error('上传数据序号异常。');
    if (!Number.isInteger(index) || index < 0 || index + 1 !== partNumber) return error('上传数据索引异常。');
    if (!/^[a-f0-9]{64}$/i.test(expectedChecksum)) return error('上传数据校验码无效。');
    if (!Number.isInteger(expectedLength) || expectedLength <= 0 || expectedLength > MAX_PART_BYTES) return error('上传数据大小异常。');
    if (!isLastPart && expectedLength < MIN_MULTIPART_PART_SIZE) return error('上传数据大小不符合要求。');

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength !== expectedLength) return error('上传数据大小与声明不一致。', 409);
    if (await sha256Bytes(bytes) !== expectedChecksum) return error('上传数据校验失败。', 409);

    let part;
    try {
        const multipart = bucket.resumeMultipartUpload(key, uploadId);
        part = await multipart.uploadPart(partNumber, bytes);
    } catch (err) {
        return error(err instanceof Error ? err.message : '上传数据失败。', 409);
    }
    return json({
        ok: true,
        partNumber: part.partNumber,
        etag: part.etag,
        index,
        byteLength: bytes.byteLength,
        checksum: expectedChecksum
    });
}

function normalizeUploadedParts(parts, chunkCount) {
    if (!Array.isArray(parts)) return null;
    const byPartNumber = new Map();
    for (const item of parts) {
        const partNumber = Number(item?.partNumber);
        const etag = typeof item?.etag === 'string' ? item.etag : '';
        if (!Number.isInteger(partNumber) || partNumber <= 0 || partNumber > chunkCount || !etag) return null;
        byPartNumber.set(partNumber, { partNumber, etag });
    }
    return byPartNumber;
}

async function copyReusableParts(bucket, multipart, current, chunkManifest, uploadedPartMap) {
    if (!current?.snapshotKey) return [];

    const currentChunkLookup = buildChunkLookup(current);
    const copyJobs = [];
    for (const item of chunkManifest) {
        const partNumber = item.index + 1;
        if (uploadedPartMap.has(partNumber)) continue;

        const currentItem = currentChunkLookup.get(chunkSignature(item));
        if (!isSameChunk(item, currentItem)) continue;
        copyJobs.push({ item, currentItem, partNumber });
    }

    let cursor = 0;
    const copiedIndices = [];
    const workerCount = Math.min(COPY_REUSED_PART_CONCURRENCY, copyJobs.length);

    async function copyNextPart() {
        while (cursor < copyJobs.length) {
            const job = copyJobs[cursor];
            cursor += 1;

            const offset = Number(job.currentItem.byteOffset);
            const byteLength = getChunkLength(job.currentItem);
            if (!Number.isFinite(offset) || !Number.isFinite(byteLength) || byteLength <= 0) {
                throw new Error(`服务器旧数据字节信息缺失：${job.item.index}`);
            }

            const object = await bucket.get(current.snapshotKey, { range: { offset, length: byteLength } });
            if (!object) throw new Error(`服务器旧数据缺失：${job.item.index}`);

            const bytes = new Uint8Array(await object.arrayBuffer());
            if (bytes.byteLength !== byteLength || await sha256Bytes(bytes) !== String(job.item.checksum)) {
                throw new Error(`服务器旧数据校验失败：${job.item.index}`);
            }

            const part = await multipart.uploadPart(job.partNumber, bytes);
            uploadedPartMap.set(part.partNumber, { partNumber: part.partNumber, etag: part.etag });
            copiedIndices.push(job.item.index);
        }
    }

    if (workerCount > 0) {
        await Promise.all(Array.from({ length: workerCount }, () => copyNextPart()));
    }
    return copiedIndices.sort((a, b) => a - b);
}

async function handleUploadComplete(bucket, body) {
    const uploadId = typeof body.uploadId === 'string' ? body.uploadId : '';
    const key = sanitizeSnapshotKey(body.key);
    const checksum = typeof body.checksum === 'string' ? body.checksum.toLowerCase() : '';
    const recordCount = Number.isFinite(Number(body.recordCount)) ? Number(body.recordCount) : 0;
    const chunkSize = Number.isFinite(Number(body.chunkSize)) ? Number(body.chunkSize) : 0;
    const chunkCount = Number.isFinite(Number(body.chunkCount)) ? Number(body.chunkCount) : 0;
    const totalBytes = Number.isFinite(Number(body.totalBytes)) ? Number(body.totalBytes) : 0;

    if (!uploadId || !key) return error('上传会话无效，请重新上传。');
    if (!/^[a-f0-9]{64}$/i.test(checksum)) return error('本地数据校验码无效。');
    if (!Number.isInteger(chunkCount) || chunkCount <= 0 || chunkCount > MAX_CHUNK_COUNT) return error('上传数据数量异常。');
    if (!Number.isInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_TOTAL_BYTES) return error(`本地数据太大：${totalBytes}/${MAX_TOTAL_BYTES}。`);

    let chunkManifest;
    try {
        chunkManifest = normalizeChunkManifest(body.chunkManifest, totalBytes);
    } catch (err) {
        return error(err instanceof Error ? err.message : '上传数据清单无效。');
    }

    const uploadedPartMap = normalizeUploadedParts(body.parts, chunkCount);
    if (!uploadedPartMap) return error('上传数据提交信息不完整。', 409);

    const previous = await getManifest(bucket);
    if (previous?.checksum === checksum) {
        return json({
            ok: true,
            version: previous.version,
            checksum: previous.checksum,
            updatedAt: previous.updatedAt,
            reusedChunkCount: 0,
            alreadyCommitted: true
        });
    }

    let completedObject = null;
    const existingObject = await bucket.get(key);
    if (existingObject) {
        if (existingObject.size !== totalBytes) {
            return error('服务器已有同名异常数据，请重新上传。', 409);
        }
        completedObject = existingObject;
    }

    const multipart = bucket.resumeMultipartUpload(key, uploadId);
    let reusedIndices;
    if (completedObject) {
        reusedIndices = [];
    } else {
        try {
            reusedIndices = await copyReusableParts(bucket, multipart, previous, chunkManifest, uploadedPartMap);
        } catch (err) {
            return error(err instanceof Error ? err.message : '复用服务器旧数据失败。', 409);
        }

        const missingIndices = [];
        for (let index = 0; index < chunkCount; index += 1) {
            if (!uploadedPartMap.has(index + 1)) missingIndices.push(index);
        }
        if (missingIndices.length > 0) {
            return error('上传数据不完整。', 409, { missingIndices });
        }

        const parts = Array.from(uploadedPartMap.values()).sort((a, b) => a.partNumber - b.partNumber);
        try {
            completedObject = await multipart.complete(parts);
        } catch (err) {
            return error(err instanceof Error ? err.message : '完成上传失败。', 409);
        }
    }
    if (!completedObject) return error('R2 multipart complete failed.', 409);
    if (completedObject.size !== totalBytes) return error('R2 快照大小校验失败。', 409);

    const committedManifest = {
        version: Number(previous?.version || 0) + 1,
        checksum,
        updatedAt: Date.now(),
        recordCount,
        totalBytes,
        chunkSize,
        chunkCount,
        snapshotKey: key,
        chunkManifest,
        mode: 'r2-client-multipart-v2'
    };

    await bucket.put(MANIFEST_KEY, JSON.stringify(committedManifest), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' }
    });

    if (previous?.snapshotKey && previous.snapshotKey !== key) {
        try {
            await bucket.delete(previous.snapshotKey);
        } catch (err) {
            console.warn('[RP Sync] Failed to delete old snapshot:', err);
        }
    }

    return json({
        ok: true,
        version: committedManifest.version,
        checksum: committedManifest.checksum,
        updatedAt: committedManifest.updatedAt,
        reusedChunkCount: reusedIndices.length
    });
}

async function handleUploadAbort(bucket, body) {
    const uploadId = typeof body.uploadId === 'string' ? body.uploadId : '';
    const key = sanitizeSnapshotKey(body.key);
    if (!uploadId || !key) return json({ ok: true, aborted: false });
    await bucket.resumeMultipartUpload(key, uploadId).abort();
    return json({ ok: true, aborted: true });
}

async function handleJsonApi(request, env) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: { allow: 'POST, OPTIONS' } });
    }
    if (request.method !== 'POST') return error('Method not allowed.', 405);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return error('Invalid JSON body.');
    if (body.action === 'auth-status') return handleAuthStatus(request, env);
    if (!await isRequestAuthorized(request, env)) return error('Sync password required.', 401, { authRequired: true });

    const bucket = getBucket(env);
    if (body.action === 'pull-manifest' || body.action === 'status') return handleStatus(bucket);
    if (body.action === 'pull-json-part') return handlePullJsonPart(bucket, body);
    if (body.action === 'upload-create') return handleUploadCreate(bucket, body);
    if (body.action === 'upload-complete') return handleUploadComplete(bucket, body);
    if (body.action === 'upload-abort') return handleUploadAbort(bucket, body);
    return error('Unsupported action.', 404);
}

async function handleApi(request, env, url) {
    try {
        if (url.searchParams.get('action') === 'upload-part') {
            if (request.method !== 'POST') return error('Method not allowed.', 405);
            if (!await isRequestAuthorized(request, env)) return error('Sync password required.', 401, { authRequired: true });
            return handleUploadPart(request, getBucket(env), url);
        }
        return handleJsonApi(request, env);
    } catch (err) {
        return error(err instanceof Error ? err.message : 'Unexpected server error.', 500);
    }
}

async function serveStatic(request, env) {
    if (!env?.ASSETS || typeof env.ASSETS.fetch !== 'function') {
        throw new Error('Missing ASSETS binding. Pages Advanced Mode requires env.ASSETS.fetch(request).');
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
        if (url.pathname === API_PATH) {
            return handleApi(request, env, url);
        }
        return serveStatic(request, env);
    }
};
