(function () {
    const PAGE_SCOPE = ['/', '/index.html'];
    if (!PAGE_SCOPE.includes(location.pathname)) {
        return;
    }

    const CONFIG = {
        apiEndpoint: '/api/rp-sync',
        passwordStorageKey: 'rp_hub_sync_password_v1',
        knownDatabases: [
            { name: 'RPHubDB', stores: ['store'] },
            { name: 'AICharGen', stores: ['characters'] }
        ],
        localStoragePrefixes: ['rp_hub_', 'ai_chargen_'],
        localStorageKeys: [],
        ignoredLocalStorageKeys: ['roleplay_hub_update_id'],
        chunkSize: 8 * 1024 * 1024,
        maxSnapshotBytes: 512 * 1024 * 1024,
        uploadPartConcurrency: 3,
        downloadPartConcurrency: 3,
        jsonDownloadPartChunks: 2,
        requestTimeoutMs: 60_000,
        uploadPartTimeoutMs: 120_000,
        commitTimeoutMs: 120_000,
        retryCount: 3,
        retryDelayMs: 600,
        restoreBatchSize: 16
    };

    const state = {
        mounted: false,
        syncing: false,
        progress: 0,
        statusText: '请选择同步方向。'
    };

    let syncButton = null;
    let modalRoot = null;
    let modalTitle = null;
    let modalStatus = null;
    let modalProgressBar = null;
    let modalProgressValue = null;
    let pullButton = null;
    let pushButton = null;
    let closeButton = null;
    let passwordModalRoot = null;
    let passwordInput = null;
    let passwordStatus = null;
    let passwordSubmitButton = null;
    let checkingPassword = false;

    function wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function getStoredSyncPassword() {
        return localStorage.getItem(CONFIG.passwordStorageKey) || '';
    }

    function saveStoredSyncPassword(password) {
        localStorage.setItem(CONFIG.passwordStorageKey, password);
    }

    function clearStoredSyncPassword() {
        localStorage.removeItem(CONFIG.passwordStorageKey);
    }

    function openDbByName(dbName, version) {
        return new Promise((resolve, reject) => {
            const request = typeof version === 'number'
                ? indexedDB.open(dbName, version)
                : indexedDB.open(dbName);
            request.onerror = () => reject(request.error || new Error('IndexedDB open failed.'));
            request.onsuccess = () => resolve(request.result);
        });
    }

    function createObjectStoreFromSnapshot(db, storeDef) {
        if (db.objectStoreNames.contains(storeDef.name)) return;

        const options = {};
        if (storeDef.keyPath !== null && typeof storeDef.keyPath !== 'undefined') {
            options.keyPath = storeDef.keyPath;
        }
        if (storeDef.autoIncrement) {
            options.autoIncrement = true;
        }

        db.createObjectStore(storeDef.name, options);
    }

    function openDbForRestore(dbDef) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(dbDef.name);

            request.onerror = () => reject(request.error || new Error('IndexedDB restore open failed.'));
            request.onupgradeneeded = () => {
                const db = request.result;
                for (const storeDef of dbDef.stores || []) {
                    createObjectStoreFromSnapshot(db, storeDef);
                }
            };
            request.onsuccess = () => {
                const db = request.result;
                const missingStores = (dbDef.stores || [])
                    .filter((storeDef) => !db.objectStoreNames.contains(storeDef.name));

                if (missingStores.length === 0) {
                    resolve(db);
                    return;
                }

                const nextVersion = db.version + 1;
                db.close();

                const upgradeRequest = indexedDB.open(dbDef.name, nextVersion);
                upgradeRequest.onerror = () => reject(upgradeRequest.error || new Error('IndexedDB restore upgrade failed.'));
                upgradeRequest.onupgradeneeded = () => {
                    const upgradedDb = upgradeRequest.result;
                    for (const storeDef of dbDef.stores || []) {
                        createObjectStoreFromSnapshot(upgradedDb, storeDef);
                    }
                };
                upgradeRequest.onsuccess = () => resolve(upgradeRequest.result);
            };
        });
    }

    function isAppLocalStorageKey(key) {
        return key !== CONFIG.passwordStorageKey
            && !key.startsWith('rp_hub_sync_')
            && !CONFIG.ignoredLocalStorageKeys.includes(key)
            && (CONFIG.localStorageKeys.includes(key)
                || CONFIG.localStoragePrefixes.some((prefix) => key.startsWith(prefix)));
    }

    function readLocalStorageSnapshot() {
        const entries = [];
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key === null || !isAppLocalStorageKey(key)) continue;
            entries.push({
                key,
                value: localStorage.getItem(key)
            });
        }
        entries.sort((a, b) => a.key.localeCompare(b.key));
        return entries;
    }

    function restoreLocalStorageSnapshot(entries) {
        clearAppLocalStorage();
        for (const entry of Array.isArray(entries) ? entries : []) {
            if (typeof entry?.key === 'string' && isAppLocalStorageKey(entry.key)) {
                localStorage.setItem(entry.key, String(entry.value ?? ''));
            }
        }
    }

    function clearAppLocalStorage() {
        const keysToRemove = [];
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key !== null && isAppLocalStorageKey(key)) {
                keysToRemove.push(key);
            }
        }
        for (const key of keysToRemove) {
            localStorage.removeItem(key);
        }
    }

    async function listIndexedDbNames() {
        const knownNames = CONFIG.knownDatabases.map((dbDef) => dbDef.name);

        if (typeof indexedDB.databases === 'function') {
            try {
                const databases = await indexedDB.databases();
                const existingNames = new Set((databases || [])
                    .map((dbInfo) => dbInfo?.name)
                    .filter((name) => typeof name === 'string' && name));
                return knownNames.filter((name) => existingNames.has(name));
            } catch (error) {
                // Some browsers expose indexedDB.databases but may reject it.
            }
        }

        return knownNames;
    }

    function readObjectStoreRecords(db, storeName) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([storeName], 'readonly');
            const store = tx.objectStore(storeName);
            const records = [];
            const request = store.openCursor();

            request.onerror = () => reject(request.error || new Error('Cursor read failed.'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    records.sort((a, b) => JSON.stringify(a.key).localeCompare(JSON.stringify(b.key)));
                    resolve(records);
                    return;
                }

                records.push({
                    key: cursor.key,
                    value: cursor.value
                });
                cursor.continue();
            };
        });
    }

    async function readIndexedDbSnapshot() {
        const databases = [];
        const dbNames = await listIndexedDbNames();

        for (const dbName of dbNames) {
            let db = null;
            try {
                const knownDb = CONFIG.knownDatabases.find((dbDef) => dbDef.name === dbName);
                const knownStores = knownDb ? knownDb.stores : [];
                db = await openDbByName(dbName);
                const stores = [];

                for (const storeName of knownStores.filter((name) => db.objectStoreNames.contains(name))) {
                    const tx = db.transaction([storeName], 'readonly');
                    const store = tx.objectStore(storeName);
                    const storeDef = {
                        name: storeName,
                        keyPath: store.keyPath,
                        autoIncrement: Boolean(store.autoIncrement),
                        records: []
                    };
                    storeDef.records = await readObjectStoreRecords(db, storeName);
                    stores.push(storeDef);
                }

                if (stores.length > 0) {
                    databases.push({
                        name: dbName,
                        version: db.version,
                        stores
                    });
                }
            } catch (error) {
                console.warn('[RP Sync] Failed to read IndexedDB:', dbName, error);
            } finally {
                if (db) db.close();
            }
        }

        return databases;
    }

    function stableKeyToken(key) {
        return JSON.stringify(key);
    }

    function readObjectStoreKeys(db, storeName) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([storeName], 'readonly');
            const store = tx.objectStore(storeName);
            const keys = [];
            const request = store.openKeyCursor();

            request.onerror = () => reject(request.error || new Error('IndexedDB key read failed.'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve(keys);
                    return;
                }

                keys.push(cursor.key);
                cursor.continue();
            };
        });
    }

    function clearObjectStore(db, storeName) {
        return new Promise((resolve, reject) => {
            if (!db.objectStoreNames.contains(storeName)) {
                resolve();
                return;
            }

            const tx = db.transaction([storeName], 'readwrite');
            const store = tx.objectStore(storeName);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('IndexedDB clear failed.'));
            store.clear();
        });
    }

    async function clearKnownIndexedDbStores(dbDef, storeNames) {
        const dbNames = await listIndexedDbNames();
        if (!dbNames.includes(dbDef.name)) return;

        const db = await openDbByName(dbDef.name);
        try {
            for (const storeName of storeNames) {
                await clearObjectStore(db, storeName);
            }
        } finally {
            db.close();
        }
    }

    async function syncObjectStoreRecords(db, storeDef) {
        const records = Array.isArray(storeDef.records) ? storeDef.records : [];
        const incomingKeys = new Set(records.map((record) => stableKeyToken(record.key)));

        for (let start = 0; start < records.length; start += CONFIG.restoreBatchSize) {
            const batch = records.slice(start, start + CONFIG.restoreBatchSize);
            await new Promise((resolve, reject) => {
                const tx = db.transaction([storeDef.name], 'readwrite');
                const store = tx.objectStore(storeDef.name);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error || new Error('IndexedDB restore failed.'));

                for (const record of batch) {
                    if (storeDef.keyPath !== null && typeof storeDef.keyPath !== 'undefined') {
                        store.put(record.value);
                    } else {
                        store.put(record.value, record.key);
                    }
                }
            });
            await wait(0);
        }

        const existingKeys = await readObjectStoreKeys(db, storeDef.name);
        const keysToDelete = existingKeys.filter((key) => !incomingKeys.has(stableKeyToken(key)));
        for (let start = 0; start < keysToDelete.length; start += CONFIG.restoreBatchSize) {
            const batch = keysToDelete.slice(start, start + CONFIG.restoreBatchSize);
            await new Promise((resolve, reject) => {
                const tx = db.transaction([storeDef.name], 'readwrite');
                const store = tx.objectStore(storeDef.name);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error || new Error('IndexedDB cleanup failed.'));

                for (const key of batch) {
                    store.delete(key);
                }
            });
            await wait(0);
        }
    }

    async function replaceIndexedDbSnapshot(databases) {
        const incomingDbMap = new Map((Array.isArray(databases) ? databases : [])
            .filter((dbDef) => dbDef && typeof dbDef.name === 'string')
            .map((dbDef) => [dbDef.name, dbDef]));

        for (const dbDef of Array.isArray(databases) ? databases : []) {
            if (!dbDef || typeof dbDef.name !== 'string') continue;
            const knownDb = CONFIG.knownDatabases.find((item) => item.name === dbDef.name);
            if (!knownDb) continue;

            const stores = (Array.isArray(dbDef.stores) ? dbDef.stores : [])
                .filter((storeDef) => knownDb.stores.includes(storeDef?.name));
            if (stores.length === 0) continue;

            const db = await openDbForRestore(dbDef);
            try {
                for (const storeDef of stores) {
                    if (!db.objectStoreNames.contains(storeDef.name)) continue;
                    await syncObjectStoreRecords(db, storeDef);
                }
            } finally {
                db.close();
            }
        }

        for (const knownDb of CONFIG.knownDatabases) {
            const incomingDb = incomingDbMap.get(knownDb.name);
            if (!incomingDb) {
                await clearKnownIndexedDbStores(knownDb, knownDb.stores);
                continue;
            }

            const incomingStoreNames = new Set((Array.isArray(incomingDb.stores) ? incomingDb.stores : [])
                .map((storeDef) => storeDef?.name)
                .filter((storeName) => knownDb.stores.includes(storeName)));
            const missingStores = knownDb.stores.filter((storeName) => !incomingStoreNames.has(storeName));
            if (missingStores.length > 0) {
                await clearKnownIndexedDbStores(knownDb, missingStores);
            }
        }
    }

    async function replaceLocalSnapshot(snapshot) {
        if (snapshot && Array.isArray(snapshot.localStorage)) {
            restoreLocalStorageSnapshot(snapshot.localStorage);
        }

        if (snapshot && Array.isArray(snapshot.indexedDB)) {
            await replaceIndexedDbSnapshot(snapshot.indexedDB);
        }
    }

    async function sha256(text) {
        return sha256Bytes(new TextEncoder().encode(text));
    }

    async function sha256Bytes(bytes) {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    function createSessionId() {
        return `sync_${Date.now()}_${crypto.randomUUID().replace(/-/g, '')}`;
    }

    async function buildSnapshot() {
        const localStorageEntries = readLocalStorageSnapshot();
        const indexedDbDatabases = await readIndexedDbSnapshot();
        return buildSnapshotFromData(localStorageEntries, indexedDbDatabases);
    }

    async function buildStableSnapshot() {
        let previousSnapshot = null;

        for (let attempt = 0; attempt < 3; attempt += 1) {
            const snapshot = await buildSnapshot();
            if (previousSnapshot && previousSnapshot.checksum === snapshot.checksum) {
                return snapshot;
            }

            previousSnapshot = snapshot;
            await wait(180);
        }

        return previousSnapshot || await buildSnapshot();
    }

    async function buildSnapshotFromData(localStorageEntries, indexedDbDatabases) {
        const json = JSON.stringify({
            schemaVersion: 3,
            localStorage: localStorageEntries,
            indexedDB: indexedDbDatabases
        });
        const idbRecordCount = indexedDbDatabases.reduce((total, dbDef) => {
            return total + dbDef.stores.reduce((storeTotal, storeDef) => {
                return storeTotal + (Array.isArray(storeDef.records) ? storeDef.records.length : 0);
            }, 0);
        }, 0);
        const recordCount = localStorageEntries.length + idbRecordCount;

        return {
            json,
            checksum: await sha256(json),
            recordCount,
            totalBytes: new TextEncoder().encode(json).byteLength
        };
    }

    async function splitIntoChunks(text, chunkSize = CONFIG.chunkSize) {
        const bytes = new TextEncoder().encode(text);
        const safeChunkSize = Math.max(5 * 1024 * 1024, Number(chunkSize) || CONFIG.chunkSize);
        const chunks = [];

        for (let byteStart = 0; byteStart < bytes.length; byteStart += safeChunkSize) {
            const payloadBytes = bytes.subarray(byteStart, Math.min(byteStart + safeChunkSize, bytes.length));
            chunks.push({
                index: chunks.length,
                bytes: payloadBytes,
                checksum: await sha256Bytes(payloadBytes),
                length: payloadBytes.byteLength
            });
            await wait(0);
        }

        return chunks;
    }

    async function downloadRemoteSnapshot(allowVersionRetry = true) {
        const manifestResponse = await postSync({ action: 'pull-manifest' });
        const remote = manifestResponse.remote;
        if (!remote || !Number.isInteger(Number(remote.chunkCount)) || Number(remote.chunkCount) <= 0) {
            return null;
        }
        if (Number(remote.totalBytes || 0) > CONFIG.maxSnapshotBytes) {
            throw new Error(`服务器数据太大：${remote.totalBytes}/${CONFIG.maxSnapshotBytes}。`);
        }

        let payload;
        try {
            payload = await downloadRemoteSnapshotJsonParts(remote);
        } catch (error) {
            if (allowVersionRetry && error.status === 409) {
                await wait(300);
                return downloadRemoteSnapshot(false);
            }
            throw error;
        }

        const json = payload;
        if (remote.checksum && await sha256(json) !== remote.checksum) {
            throw new Error('服务器数据整体校验失败。');
        }

        return {
            ...remote,
            json
        };
    }

    async function downloadRemoteSnapshotJsonParts(remote) {
        const chunkCount = Number(remote.chunkCount || 0);
        if (!Number.isInteger(chunkCount) || chunkCount <= 0) {
            throw new Error('服务器数据格式不正确。');
        }

        const ranges = [];
        for (let start = 0; start < chunkCount; start += CONFIG.jsonDownloadPartChunks) {
            const count = Math.min(CONFIG.jsonDownloadPartChunks, chunkCount - start);
            ranges.push({ start, count });
        }

        const byteParts = new Array(ranges.length);
        let completed = 0;
        let cursor = 0;
        const workerCount = Math.min(CONFIG.downloadPartConcurrency, ranges.length);

        async function downloadNextRange() {
            while (cursor < ranges.length) {
                const rangeIndex = cursor;
                cursor += 1;
                const range = ranges[rangeIndex];
                const response = await postSyncBinary({
                    action: 'pull-json-part',
                    version: Number(remote.version),
                    start: range.start,
                    count: range.count
                });
                if (!response.bytes || !(response.bytes instanceof Uint8Array)) {
                    throw new Error('服务器分批数据格式不正确。');
                }
                const bytes = response.bytes;
                const expectedBytes = Number(response.byteLength || 0);
                if (expectedBytes > 0 && bytes.byteLength !== expectedBytes) {
                    throw new Error('服务器分批数据大小不正确。');
                }
                byteParts[rangeIndex] = bytes;
                completed += 1;
                updateProgress(
                    15 + Math.round((completed / ranges.length) * 35),
                    `正在下载服务器数据 ${Math.round((completed / ranges.length) * 100)}%...`
                );
                await wait(0);
            }
        }

        await Promise.all(Array.from({ length: workerCount }, () => downloadNextRange()));
        updateProgress(52, '服务器数据下载完成，正在校验...');
        const totalBytes = byteParts.reduce((sum, part) => sum + part.byteLength, 0);
        const merged = new Uint8Array(totalBytes);
        let offset = 0;
        for (const part of byteParts) {
            merged.set(part, offset);
            offset += part.byteLength;
        }
        return new TextDecoder().decode(merged);
    }

    function buildSyncHeaders(options = {}) {
        const headers = {
            'content-type': 'application/json'
        };
        const password = typeof options.password === 'string' ? options.password : getStoredSyncPassword();
        if (password) {
            headers['x-rp-sync-password'] = password;
        }
        return headers;
    }

    function buildPartHeaders(chunk, options = {}) {
        const headers = {
            'content-type': 'application/octet-stream',
            'x-rp-part-checksum': chunk.checksum,
            'x-rp-part-length': String(chunk.length)
        };
        const password = typeof options.password === 'string' ? options.password : getStoredSyncPassword();
        if (password) {
            headers['x-rp-sync-password'] = password;
        }
        return headers;
    }

    function shouldRetrySyncError(error) {
        const status = Number(error?.status || 0);
        return !status || status === 408 || status === 429 || status >= 500;
    }

    async function postSync(payload, options = {}) {
        const retryCount = Number.isInteger(options.retryCount) ? options.retryCount : CONFIG.retryCount;
        const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : CONFIG.requestTimeoutMs;
        let lastError = null;

        for (let attempt = 0; attempt <= retryCount; attempt += 1) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetch(CONFIG.apiEndpoint, {
                    method: 'POST',
                    headers: buildSyncHeaders(options),
                    body: JSON.stringify(payload),
                    credentials: 'same-origin',
                    signal: controller.signal
                });

                const data = await response.json().catch(() => ({}));
                if (!response.ok || !data.ok) {
                    if (response.status === 401 && !options.keepPasswordOnAuthError) {
                        clearStoredSyncPassword();
                    }
                    throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { response: data, status: response.status });
                }
                return data;
            } catch (error) {
                const isAbort = error?.name === 'AbortError';
                const status = isAbort ? 0 : error?.status;
                const normalizedError = isAbort
                    ? new Error('同步请求超时，请检查网络后重试。')
                    : (error instanceof Error ? error : new Error(String(error)));
                lastError = Object.assign(normalizedError, { status });
                if (attempt >= retryCount || !shouldRetrySyncError(lastError)) {
                    throw lastError;
                }
                await wait(CONFIG.retryDelayMs * (attempt + 1));
            } finally {
                clearTimeout(timeoutId);
            }
        }

        throw lastError || new Error('同步请求失败。');
    }

    async function postSyncBinary(payload, options = {}) {
        const retryCount = Number.isInteger(options.retryCount) ? options.retryCount : CONFIG.retryCount;
        const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : CONFIG.requestTimeoutMs;
        let lastError = null;

        for (let attempt = 0; attempt <= retryCount; attempt += 1) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetch(CONFIG.apiEndpoint, {
                    method: 'POST',
                    headers: buildSyncHeaders(options),
                    body: JSON.stringify(payload),
                    credentials: 'same-origin',
                    signal: controller.signal
                });

                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    if (response.status === 401 && !options.keepPasswordOnAuthError) {
                        clearStoredSyncPassword();
                    }
                    throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { response: data, status: response.status });
                }

                const bytes = new Uint8Array(await response.arrayBuffer());
                return {
                    ok: true,
                    bytes,
                    byteLength: Number(response.headers.get('x-rp-sync-byte-length') || bytes.byteLength)
                };
            } catch (error) {
                const isAbort = error?.name === 'AbortError';
                const status = isAbort ? 0 : error?.status;
                const normalizedError = isAbort
                    ? new Error('同步请求超时，请检查网络后重试。')
                    : (error instanceof Error ? error : new Error(String(error)));
                lastError = Object.assign(normalizedError, { status });
                if (attempt >= retryCount || !shouldRetrySyncError(lastError)) {
                    throw lastError;
                }
                await wait(CONFIG.retryDelayMs * (attempt + 1));
            } finally {
                clearTimeout(timeoutId);
            }
        }

        throw lastError || new Error('同步请求失败。');
    }

    async function postUploadPart(upload, chunk) {
        const retryCount = CONFIG.retryCount;
        let lastError = null;
        const params = new URLSearchParams({
            action: 'upload-part',
            uploadId: upload.uploadId,
            key: upload.key,
            index: String(chunk.index),
            partNumber: String(chunk.index + 1),
            last: chunk.index === upload.chunkCount - 1 ? '1' : '0'
        });

        for (let attempt = 0; attempt <= retryCount; attempt += 1) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONFIG.uploadPartTimeoutMs);
            try {
                const response = await fetch(`${CONFIG.apiEndpoint}?${params.toString()}`, {
                    method: 'POST',
                    headers: buildPartHeaders(chunk),
                    body: chunk.bytes,
                    credentials: 'same-origin',
                    signal: controller.signal
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || !data.ok) {
                    if (response.status === 401) clearStoredSyncPassword();
                    throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { response: data, status: response.status });
                }
                return {
                    partNumber: Number(data.partNumber),
                    etag: data.etag,
                    index: chunk.index,
                    byteLength: chunk.length,
                    checksum: chunk.checksum
                };
            } catch (error) {
                const isAbort = error?.name === 'AbortError';
                const status = isAbort ? 0 : error?.status;
                const normalizedError = isAbort
                    ? new Error('上传超时，请检查网络后重试。')
                    : (error instanceof Error ? error : new Error(String(error)));
                lastError = Object.assign(normalizedError, { status });
                if (attempt >= retryCount || !shouldRetrySyncError(lastError)) {
                    throw lastError;
                }
                await wait(CONFIG.retryDelayMs * (attempt + 1));
            } finally {
                clearTimeout(timeoutId);
            }
        }

        throw lastError || new Error('上传失败。');
    }

    async function uploadParts(upload, chunks) {
        const parts = [];
        let cursor = 0;
        let completed = 0;
        const workerCount = Math.min(CONFIG.uploadPartConcurrency, chunks.length);

        if (chunks.length === 0) {
            return parts;
        }

        async function uploadNextPart() {
            while (cursor < chunks.length) {
                const chunk = chunks[cursor];
                cursor += 1;
                const part = await postUploadPart(upload, chunk);
                parts.push(part);
                completed += 1;
                updateProgress(
                    36 + Math.round((completed / chunks.length) * 52),
                    `正在上传服务器数据 ${Math.round((completed / chunks.length) * 100)}%...`
                );
                await wait(0);
            }
        }

        await Promise.all(Array.from({ length: workerCount }, () => uploadNextPart()));
        return parts.sort((a, b) => a.partNumber - b.partNumber);
    }

    function updateProgress(progress, text) {
        state.progress = Math.max(0, Math.min(100, progress));
        state.statusText = text || state.statusText;
        if (modalProgressBar) {
            modalProgressBar.style.width = `${state.progress}%`;
        }
        if (modalProgressValue) {
            modalProgressValue.textContent = `${Math.round(state.progress)}%`;
        }
        if (modalStatus) {
            modalStatus.textContent = state.statusText;
        }
    }

    function updateButtonState() {
        if (!syncButton) return;
        syncButton.classList.toggle('is-syncing', state.syncing);
        syncButton.querySelector('.rp-sync-button__label').textContent = state.syncing ? '处理中' : '同步';
    }

    function setActionButtonsDisabled(disabled) {
        if (pullButton) pullButton.disabled = disabled;
        if (pushButton) pushButton.disabled = disabled;
        if (closeButton) closeButton.disabled = disabled;
    }

    function getVueProxy() {
        const appRoot = document.getElementById('app');
        return appRoot?.__vue_app__?._instance?.proxy || null;
    }

    async function flushAppState() {
        const start = Date.now();
        while (Date.now() - start < 8_000) {
            const proxy = getVueProxy();
            if (proxy && typeof proxy.manualSave === 'function') {
                const result = proxy.manualSave();
                if (result && typeof result.then === 'function') {
                    await result;
                }
                await wait(600);
                return;
            }
            await wait(150);
        }
    }

    async function getAuthStatus(password = getStoredSyncPassword()) {
        return postSync({ action: 'auth-status' }, {
            password,
            keepPasswordOnAuthError: true
        });
    }

    function ensurePasswordModal() {
        if (passwordModalRoot) return;

        passwordModalRoot = document.createElement('div');
        passwordModalRoot.className = 'rp-sync-modal rp-sync-password-modal';
        passwordModalRoot.innerHTML = `
            <div class="rp-sync-modal__backdrop"></div>
            <form class="rp-sync-modal__panel rp-sync-password-panel">
                <div class="rp-sync-modal__header">
                    <div>
                        <div class="rp-sync-modal__eyebrow">Sync Password</div>
                        <h3 class="rp-sync-modal__title">同步密码</h3>
                    </div>
                    <button type="button" class="rp-sync-modal__close" aria-label="关闭">×</button>
                </div>
                <p class="rp-sync-modal__intro">当前站点已开启同步密码。输入一次后会保存在这个浏览器里，下次同步不需要再输入。</p>
                <label class="rp-sync-password-field">
                    <span>密码</span>
                    <input type="password" autocomplete="current-password" placeholder="请输入同步密码">
                </label>
                <p class="rp-sync-password-status">请输入同步密码。</p>
                <div class="rp-sync-modal__actions">
                    <button type="button" class="rp-sync-modal__button" data-action="cancel-password">取消</button>
                    <button type="submit" class="rp-sync-modal__button is-primary" data-action="submit-password">继续同步</button>
                </div>
            </form>
        `;

        document.body.appendChild(passwordModalRoot);
        passwordInput = passwordModalRoot.querySelector('input');
        passwordStatus = passwordModalRoot.querySelector('.rp-sync-password-status');
        passwordSubmitButton = passwordModalRoot.querySelector('[data-action="submit-password"]');

        const closePasswordModal = () => {
            if (checkingPassword) return;
            passwordModalRoot.classList.remove('is-open');
        };

        passwordModalRoot.querySelector('.rp-sync-modal__close').addEventListener('click', closePasswordModal);
        passwordModalRoot.querySelector('[data-action="cancel-password"]').addEventListener('click', closePasswordModal);
        passwordModalRoot.querySelector('.rp-sync-modal__backdrop').addEventListener('click', closePasswordModal);
        passwordModalRoot.querySelector('form').addEventListener('submit', (event) => {
            event.preventDefault();
            submitSyncPassword().catch(() => { });
        });
    }

    function openPasswordModal(message = '请输入同步密码。') {
        ensurePasswordModal();
        passwordStatus.textContent = message;
        passwordInput.value = '';
        passwordSubmitButton.disabled = false;
        passwordModalRoot.classList.add('is-open');
        setTimeout(() => passwordInput.focus(), 0);
    }

    function openSyncPanel() {
        state.statusText = '请选择同步方向。';
        state.progress = 0;
        openModal();
    }

    async function submitSyncPassword() {
        if (checkingPassword) return;

        const password = passwordInput.value;
        if (!password) {
            passwordStatus.textContent = '请输入同步密码。';
            passwordInput.focus();
            return;
        }

        checkingPassword = true;
        passwordSubmitButton.disabled = true;
        passwordStatus.textContent = '正在验证密码...';

        try {
            const auth = await getAuthStatus(password);
            if (auth.authRequired && !auth.authenticated) {
                clearStoredSyncPassword();
                passwordStatus.textContent = '密码不正确，请重新输入。';
                passwordInput.select();
                return;
            }

            if (auth.authRequired) {
                saveStoredSyncPassword(password);
            } else {
                clearStoredSyncPassword();
            }
            passwordModalRoot.classList.remove('is-open');
            openSyncPanel();
        } catch (error) {
            passwordStatus.textContent = error.message || '密码验证失败，请稍后再试。';
        } finally {
            checkingPassword = false;
            passwordSubmitButton.disabled = false;
        }
    }

    async function handleSyncButtonClick() {
        if (state.syncing || checkingPassword) return;

        syncButton.disabled = true;
        try {
            const auth = await getAuthStatus();
            if (!auth.authRequired || auth.authenticated) {
                openSyncPanel();
                return;
            }

            clearStoredSyncPassword();
            openPasswordModal('请输入同步密码后继续。');
        } catch (error) {
            if (error.status === 401) {
                clearStoredSyncPassword();
                openPasswordModal('请输入同步密码后继续。');
                return;
            }

            window.alert(error.message || '同步验证失败，请稍后再试。');
        } finally {
            syncButton.disabled = false;
        }
    }

    function ensureModal() {
        if (modalRoot) return;

        modalRoot = document.createElement('div');
        modalRoot.className = 'rp-sync-modal';
        modalRoot.innerHTML = `
            <div class="rp-sync-modal__backdrop"></div>
            <div class="rp-sync-modal__panel">
                <div class="rp-sync-modal__header">
                    <div>
                        <div class="rp-sync-modal__eyebrow">Manual Sync</div>
                        <h3 class="rp-sync-modal__title">数据同步</h3>
                    </div>
                    <button type="button" class="rp-sync-modal__close" aria-label="关闭">×</button>
                </div>
                <p class="rp-sync-modal__intro">这是纯手动同步模式。系统不会自动上传，也不会自动从服务器覆盖本地。上传时会先比较数据，只同步需要更新的内容。</p>
                <div class="rp-sync-choice-list">
                    <div class="rp-sync-choice">
                        <div class="rp-sync-choice__title">服务器同步</div>
                        <p class="rp-sync-choice__desc">把服务器里保存的数据拉回当前浏览器，并覆盖本地缓存。完成后页面会自动刷新。</p>
                        <button type="button" class="rp-sync-modal__button is-primary" data-action="pull">服务器同步</button>
                    </div>
                    <div class="rp-sync-choice">
                        <div class="rp-sync-choice__title">本地同步</div>
                        <p class="rp-sync-choice__desc">把当前浏览器里的本地数据上传到服务器。上传前会先比较数据，只同步需要更新的内容。</p>
                        <button type="button" class="rp-sync-modal__button" data-action="push">本地同步</button>
                    </div>
                </div>
                <p class="rp-sync-modal__status">请选择同步方向。</p>
                <div class="rp-sync-progress">
                    <div class="rp-sync-progress__bar"></div>
                </div>
                <div class="rp-sync-progress__value">0%</div>
                <div class="rp-sync-modal__actions">
                    <button type="button" class="rp-sync-modal__button" data-action="close">关闭</button>
                </div>
            </div>
        `;

        document.body.appendChild(modalRoot);
        modalTitle = modalRoot.querySelector('.rp-sync-modal__title');
        modalStatus = modalRoot.querySelector('.rp-sync-modal__status');
        modalProgressBar = modalRoot.querySelector('.rp-sync-progress__bar');
        modalProgressValue = modalRoot.querySelector('.rp-sync-progress__value');
        pullButton = modalRoot.querySelector('[data-action="pull"]');
        pushButton = modalRoot.querySelector('[data-action="push"]');
        closeButton = modalRoot.querySelector('[data-action="close"]');

        modalRoot.querySelector('.rp-sync-modal__close').addEventListener('click', closeModal);
        modalRoot.querySelector('.rp-sync-modal__backdrop').addEventListener('click', () => {
            if (!state.syncing) closeModal();
        });
        pullButton.addEventListener('click', () => pullFromServer().catch(() => { }));
        pushButton.addEventListener('click', () => pushToServer().catch(() => { }));
        closeButton.addEventListener('click', closeModal);
    }

    function openModal() {
        ensureModal();
        modalRoot.classList.add('is-open');
        modalTitle.textContent = '数据同步';
        updateProgress(state.progress, state.statusText || '请选择同步方向。');
        setActionButtonsDisabled(state.syncing);
    }

    function closeModal() {
        if (state.syncing || !modalRoot) return;
        modalRoot.classList.remove('is-open');
    }

    async function pullFromServer() {
        if (state.syncing) return;

        state.syncing = true;
        updateButtonState();
        openModal();
        setActionButtonsDisabled(true);

        try {
            updateProgress(10, '正在从服务器读取数据...');
            const response = await downloadRemoteSnapshot();

            if (!response) {
                updateProgress(100, '服务器当前没有可同步的数据。');
                setActionButtonsDisabled(false);
                return;
            }

            updateProgress(55, '正在写入本地浏览器数据...');
            const remoteSnapshot = JSON.parse(response.json);
            if (!remoteSnapshot || (!Array.isArray(remoteSnapshot.indexedDB) && !Array.isArray(remoteSnapshot.localStorage))) {
                throw new Error('服务器数据格式不正确。');
            }

            await replaceLocalSnapshot(remoteSnapshot);
            updateProgress(100, '服务器数据已写入本地，页面即将刷新...');
            setTimeout(() => {
                location.reload();
            }, 700);
        } catch (error) {
            updateProgress(100, error.message || '服务器同步失败。');
            setActionButtonsDisabled(false);
        } finally {
            state.syncing = false;
            updateButtonState();
        }
    }

    async function pushToServer() {
        if (state.syncing) return;

        let uploadSession = null;
        state.syncing = true;
        updateButtonState();
        openModal();
        setActionButtonsDisabled(true);

        try {
            updateProgress(8, '正在整理本地数据...');
            await flushAppState();

            updateProgress(16, '正在读取本地浏览器数据...');
            const snapshot = await buildStableSnapshot();
            if (snapshot.totalBytes > CONFIG.maxSnapshotBytes) {
                throw new Error(`本地数据太大：${snapshot.totalBytes}/${CONFIG.maxSnapshotBytes}。`);
            }

            updateProgress(24, '正在检查服务器数据...');
            const remoteStatus = await postSync({ action: 'status' });
            if (remoteStatus?.remote?.checksum && remoteStatus.remote.checksum === snapshot.checksum) {
                updateProgress(100, '服务器已是同一份数据，无需重复上传。');
                setActionButtonsDisabled(false);
                return;
            }

            updateProgress(30, '正在切分上传数据...');
            const chunks = await splitIntoChunks(snapshot.json);
            const chunkManifest = chunks.map((chunk) => ({
                index: chunk.index,
                checksum: chunk.checksum,
                length: chunk.length
            }));
            const uploadTotalBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const sessionId = createSessionId();

            uploadSession = await postSync({
                action: 'upload-create',
                sessionId,
                checksum: snapshot.checksum,
                recordCount: snapshot.recordCount,
                chunkSize: CONFIG.chunkSize,
                chunkCount: chunks.length,
                totalBytes: uploadTotalBytes,
                chunkManifest
            });

            if (uploadSession.alreadyUpToDate) {
                updateProgress(100, '服务器已是同一份数据，无需重复上传。');
                setActionButtonsDisabled(false);
                return;
            }

            const missingIndices = Array.isArray(uploadSession.missingIndices)
                ? uploadSession.missingIndices
                : chunks.map((chunk) => chunk.index);
            const chunkMap = new Map(chunks.map((chunk) => [chunk.index, chunk]));
            const chunksToUpload = missingIndices.map((index) => {
                const chunk = chunkMap.get(index);
                if (!chunk) throw new Error('本地数据不完整，请刷新页面后重试。');
                return chunk;
            });

            if (chunksToUpload.length > 0) {
                updateProgress(36, '正在上传服务器数据...');
            } else {
                updateProgress(88, '服务器已有部分数据，正在完成提交...');
            }
            const parts = await uploadParts(uploadSession, chunksToUpload);

            updateProgress(92, '正在完成服务器提交...');
            const commitResponse = await postSync({
                action: 'upload-complete',
                sessionId,
                uploadId: uploadSession.uploadId,
                key: uploadSession.key,
                checksum: snapshot.checksum,
                recordCount: snapshot.recordCount,
                chunkSize: CONFIG.chunkSize,
                chunkCount: chunks.length,
                totalBytes: uploadTotalBytes,
                chunkManifest,
                parts
            }, {
                retryCount: 1,
                timeoutMs: CONFIG.commitTimeoutMs
            });

            updateProgress(100, '上传成功。');
            setActionButtonsDisabled(false);
        } catch (error) {
            if (uploadSession?.uploadId && uploadSession?.key) {
                try {
                    await postSync({
                        action: 'upload-abort',
                        uploadId: uploadSession.uploadId,
                        key: uploadSession.key
                    }, { retryCount: 0 });
                } catch (abortError) {
                    console.warn('[RP Sync] Failed to abort upload:', abortError);
                }
            }
            updateProgress(100, error?.message || '本地同步失败。');
            setActionButtonsDisabled(false);
        } finally {
            state.syncing = false;
            updateButtonState();
        }
    }

    function mountSyncButton() {
        if (state.mounted) return;

        const profileSection = Array.from(document.querySelectorAll('#app .p-4.border-t.border-gray-100'))
            .find((element) => /User/i.test(element.textContent || ''));
        if (!profileSection) return;

        const anchor = profileSection.querySelector('.flex.items-center');
        if (!anchor) return;

        anchor.style.position = 'relative';

        const wrapper = document.createElement('div');
        wrapper.className = 'rp-sync-floating';
        wrapper.innerHTML = `
            <button type="button" class="rp-sync-button" aria-label="打开同步面板">
                <span class="rp-sync-button__label">同步</span>
            </button>
        `;

        anchor.appendChild(wrapper);
        syncButton = wrapper.querySelector('.rp-sync-button');
        syncButton.addEventListener('click', () => {
            handleSyncButtonClick().catch(() => { });
        });

        state.mounted = true;
        updateButtonState();
    }

    function watchProfileMount() {
        const observer = new MutationObserver(() => {
            mountSyncButton();
            if (state.mounted) {
                observer.disconnect();
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        mountSyncButton();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            ensureModal();
            watchProfileMount();
        }, { once: true });
    } else {
        ensureModal();
        watchProfileMount();
    }
})();
