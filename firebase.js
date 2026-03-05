// ============================================
// firebase.js - v10 - Production Ready
// ============================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import {
    getAuth,
    createUserWithEmailAndPassword as _createUser,
    signInWithEmailAndPassword     as _signIn,
    signOut                        as _signOut,
    sendEmailVerification          as _sendVerification,
    sendPasswordResetEmail         as _sendReset,
    onAuthStateChanged             as _onAuthStateChanged,
    getIdToken                     as _getIdToken,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
    getFirestore,
    doc         as _doc,
    setDoc      as _setDoc,
    getDoc      as _getDoc,
    getDocs     as _getDocs,
    updateDoc   as _updateDoc,
    deleteDoc   as _deleteDoc,
    collection  as _collection,
    query       as _query,
    where       as _where,
    orderBy     as _orderBy,
    limit       as _limit,
    serverTimestamp as _serverTimestamp,
    Timestamp   as _Timestamp,
    onSnapshot  as _onSnapshot,
    writeBatch  as _writeBatch,
    arrayUnion  as _arrayUnion,
    arrayRemove as _arrayRemove,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

// ════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════
const WORKER_BASE_URL = 'https://dashverse-api-proxy.thondaladinne-masthan.workers.dev';
const MAX_RETRIES     = 3;
const FETCH_TIMEOUT   = 15000;

// ════════════════════════════════════════════
// Internal state
// ════════════════════════════════════════════
let _app               = null;
let _authInstance      = null;
let _dbInstance        = null;
let _initialized       = false;
let _initPromise       = null;
let _initError         = null;
let _authListenerQueue = [];

// ════════════════════════════════════════════
// Security: Fetch with timeout
// ════════════════════════════════════════════
async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            ...options,
            signal:         controller.signal,
            referrer:       'no-referrer',
            referrerPolicy: 'no-referrer',
        });
        clearTimeout(timeoutId);
        return response;
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms`);
        throw e;
    }
}

// ════════════════════════════════════════════
// Initialize Firebase via Worker
// ════════════════════════════════════════════
async function _doInit() {
    if (_initialized) return;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            if (attempt > 1) {
                const delay = Math.min(1000 * Math.pow(2, attempt - 2), 4000);
                await new Promise(r => setTimeout(r, delay));
            }

            const configUrl = `${WORKER_BASE_URL}/api/config`;
            console.log(`[Firebase] Init attempt ${attempt}: fetching config`);

            const response = await fetchWithTimeout(
                configUrl,
                {
                    method:      'GET',
                    credentials: 'omit',
                    cache:       'no-store',
                    headers: {
                        'Accept':           'application/json',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                },
                FETCH_TIMEOUT
            );

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                throw new Error(`Config fetch failed: HTTP ${response.status} - ${errText.substring(0, 200)}`);
            }

            let config;
            try {
                config = await response.json();
            } catch (_) {
                throw new Error('Failed to parse server configuration');
            }

            if (config.error) throw new Error(`Server config error: ${config.error}`);

            const missing = [];
            if (!config.apiKey)     missing.push('apiKey');
            if (!config.authDomain) missing.push('authDomain');
            if (!config.projectId)  missing.push('projectId');
            if (missing.length > 0) throw new Error(`Incomplete config, missing: ${missing.join(', ')}`);

            if (typeof config.apiKey !== 'string' || config.apiKey.length < 10)
                throw new Error('Invalid apiKey received from server');

            _app          = initializeApp(config);
            _authInstance = getAuth(_app);
            _dbInstance   = getFirestore(_app);
            _initialized  = true;
            _initError    = null;

            console.log('[Firebase] ✅ Initialized successfully');

            // Flush queued auth listeners
            if (_authListenerQueue.length > 0) {
                _authListenerQueue.forEach(({ callback, resolveUnsub }) => {
                    const unsub = _onAuthStateChanged(_authInstance, callback);
                    resolveUnsub(unsub);
                });
                _authListenerQueue = [];
            }
            return;

        } catch (err) {
            lastError = err;
            console.error(`[Firebase] Init attempt ${attempt} failed:`, err.message);

            const isRetryable = (
                err.message.includes('timed out')       ||
                err.message.includes('Failed to fetch') ||
                err.message.includes('NetworkError')    ||
                err.message.includes('network')         ||
                err.message.includes('HTTP 5')
            );

            if (!isRetryable && attempt === 1) break;
        }
    }

    _initError = lastError;
    console.error('[Firebase] ❌ All init attempts failed:', lastError?.message);

    _authListenerQueue.forEach(({ callback }) => {
        try { callback(null); } catch (e) {}
    });
    _authListenerQueue = [];

    throw lastError;
}

function ensureInitialized() {
    if (!_initPromise) _initPromise = _doInit();
    return _initPromise;
}

// Start initializing immediately
ensureInitialized().catch(e => {
    console.error('[Firebase] Background init failed:', e.message);
});

// ════════════════════════════════════════════
// Auth proxy
// ════════════════════════════════════════════
const auth = new Proxy({}, {
    get(target, prop) {
        if (prop === 'currentUser') return _authInstance?.currentUser ?? null;
        if (prop === 'signOut')     return () => _authInstance?.signOut() ?? Promise.resolve();
        if (prop === 'app')         return _authInstance?.app ?? null;
        if (prop === 'name')        return _authInstance?.name ?? '[DEFAULT]';
        if (prop === 'config')      return _authInstance?.config ?? {};
        if (_authInstance && prop in _authInstance) {
            const val = _authInstance[prop];
            return typeof val === 'function' ? val.bind(_authInstance) : val;
        }
        return undefined;
    },
});

// ════════════════════════════════════════════
// Firestore proxy
// ════════════════════════════════════════════
const db = new Proxy({}, {
    get(target, prop) {
        if (!_dbInstance) {
            if (prop === 'type')   return 'firestore';
            if (prop === 'app')    return null;
            if (prop === 'toJSON') return () => ({});
            return undefined;
        }
        const val = _dbInstance[prop];
        return typeof val === 'function' ? val.bind(_dbInstance) : val;
    },
});

// ════════════════════════════════════════════
// Firestore helpers
// ════════════════════════════════════════════
function _resolveDb(ref) {
    if (ref === db) {
        if (!_dbInstance) throw new Error('Firestore not initialized yet');
        return _dbInstance;
    }
    return ref;
}

function doc(dbRef, ...args)        { return _doc(_resolveDb(dbRef), ...args); }
function collection(dbRef, ...args) { return _collection(_resolveDb(dbRef), ...args); }
function writeBatch(dbRef)          { return _writeBatch(_resolveDb(dbRef)); }
function setDoc(...args)            { return _setDoc(...args); }
function getDoc(...args)            { return _getDoc(...args); }
function getDocs(...args)           { return _getDocs(...args); }
function updateDoc(...args)         { return _updateDoc(...args); }
function deleteDoc(...args)         { return _deleteDoc(...args); }
function query(...args)             { return _query(...args); }
function where(...args)             { return _where(...args); }
function orderBy(...args)           { return _orderBy(...args); }
function limit(...args)             { return _limit(...args); }
function onSnapshot(...args)        { return _onSnapshot(...args); }
function serverTimestamp()          { return _serverTimestamp(); }
function arrayUnion(...args)        { return _arrayUnion(...args); }
function arrayRemove(...args)       { return _arrayRemove(...args); }
const Timestamp = _Timestamp;

// ════════════════════════════════════════════
// Auth helpers
// ════════════════════════════════════════════
function onAuthStateChanged(authRefOrCb, maybeCb) {
    const cb = typeof authRefOrCb === 'function' ? authRefOrCb : maybeCb;
    if (!cb || typeof cb !== 'function') return () => {};

    if (_initialized && _authInstance) {
        return _onAuthStateChanged(_authInstance, cb);
    }
    if (_initError) {
        try { cb(null); } catch (e) {}
        return () => {};
    }

    let unsubscribe = null;
    let cancelled   = false;

    const entry = {
        callback:     cb,
        resolveUnsub: (unsub) => {
            if (cancelled) { try { unsub(); } catch (e) {} }
            else            { unsubscribe = unsub; }
        },
    };

    _authListenerQueue.push(entry);
    ensureInitialized().catch(() => {});

    return () => {
        cancelled = true;
        if (unsubscribe) { try { unsubscribe(); } catch (e) {} }
        const idx = _authListenerQueue.indexOf(entry);
        if (idx !== -1) _authListenerQueue.splice(idx, 1);
    };
}

async function signInWithEmailAndPassword(authRef, email, password) {
    await ensureInitialized();
    const e = sanitizeInput(email, 254).toLowerCase();
    const p = String(password || '').substring(0, 128);
    if (!isValidEmail(e)) throw new Error('Invalid email format');
    return _signIn(_authInstance, e, p);
}

async function createUserWithEmailAndPassword(authRef, email, password) {
    await ensureInitialized();
    const e = sanitizeInput(email, 254).toLowerCase();
    const p = String(password || '').substring(0, 128);
    if (!isValidEmail(e)) throw new Error('Invalid email format');
    return _createUser(_authInstance, e, p);
}

async function signOut(authRef) {
    await ensureInitialized();
    return _signOut(_authInstance);
}

async function sendEmailVerification(user) {
    await ensureInitialized();
    return _sendVerification(user);
}

async function sendPasswordResetEmail(authRef, email) {
    await ensureInitialized();
    const e = sanitizeInput(email, 254).toLowerCase();
    if (!isValidEmail(e)) throw new Error('Invalid email format');
    return _sendReset(_authInstance, e);
}

// ════════════════════════════════════════════
// getIdToken — exported and used by dashboards
// FIXED: Always calls ensureInitialized() first,
//        validates user exists before calling,
//        and handles all token error codes.
// ════════════════════════════════════════════
async function getIdToken(forceRefresh = false) {
    // ── Step 1: ensure Firebase is fully ready ──────────────────────
    try {
        await ensureInitialized();
    } catch (initErr) {
        throw new Error(`Firebase not initialized: ${initErr.message}`);
    }

    // ── Step 2: check auth instance ─────────────────────────────────
    if (!_authInstance) {
        throw new Error('Auth instance not available');
    }

    // ── Step 3: get current user ────────────────────────────────────
    const user = _authInstance.currentUser;
    if (!user) {
        throw new Error('No authenticated user — please sign in first');
    }

    // ── Step 4: validate the user object ────────────────────────────
    if (typeof user.getIdToken !== 'function') {
        throw new Error('Invalid user object — missing getIdToken method');
    }

    // ── Step 5: fetch the token, auto-retry on expiry ───────────────
    try {
        const token = await _getIdToken(user, forceRefresh);

        // Sanity check — a valid JWT has 3 dot-separated parts
        if (!token || typeof token !== 'string' || token.split('.').length !== 3) {
            throw new Error('Received malformed ID token');
        }

        return token;
    } catch (e) {
        // If token is expired and we haven't tried a force-refresh yet, retry once
        const expiryCode = [
            'auth/id-token-expired',
            'auth/user-token-expired',
            'auth/invalid-user-token',
        ];
        if (!forceRefresh && expiryCode.includes(e.code)) {
            console.warn('[getIdToken] Token expired — forcing refresh');
            return getIdToken(true);
        }

        // Re-throw everything else with a clear message
        throw new Error(`Failed to get ID token: ${e.message || e.code || 'unknown error'}`);
    }
}

// ════════════════════════════════════════════
// Writer Change History Helpers
// ════════════════════════════════════════════
function buildWriterChangeEntry(fromWriter, toWriter, reason, adminEmail) {
    return {
        reason:     sanitizeInput(reason,     500),
        changedAt:  new Date().toISOString(),
        changedBy:  sanitizeInput(adminEmail, 254),
        fromWriter: sanitizeInput(fromWriter, 100),
        toWriter:   sanitizeInput(toWriter,   100),
        seenAt:     null,
        seenBy:     null,
    };
}

function markHistoryAsSeen(history, adminEmail) {
    if (!Array.isArray(history)) return [];
    const now = new Date().toISOString();
    return history.map(entry =>
        entry.seenAt ? entry : {
            ...entry,
            seenAt: now,
            seenBy: sanitizeInput(adminEmail, 254),
        }
    );
}

function hasUnseenWriterChange(show) {
    if (!show) return false;
    const history = Array.isArray(show.writerChangeHistory) ? show.writerChangeHistory : [];
    if (history.some(e => !e.seenAt)) return true;
    if (show.writerChangeReason && !show.writerChangeSeenAt) return true;
    return false;
}

function getWriterChangeHistory(show) {
    if (!show) return [];
    const history = Array.isArray(show.writerChangeHistory) ? show.writerChangeHistory : [];
    if (history.length === 0 && show.writerChangeReason) {
        return [{
            reason:     show.writerChangeReason,
            changedAt:  show.writerChangeReasonAt  || '',
            changedBy:  show.writerChangeReasonBy  || '',
            fromWriter: '',
            toWriter:   show.assignedTo            || '',
            seenAt:     show.writerChangeSeenAt    || null,
            seenBy:     null,
        }];
    }
    return history;
}

// ════════════════════════════════════════════
// Security Utilities
// ════════════════════════════════════════════
function sanitizeHTML(str) {
    if (str == null) return '';
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(String(str)));
    return d.innerHTML;
}

function sanitizeInput(str, maxLen = 500) {
    if (str == null) return '';
    return String(str).trim().substring(0, maxLen);
}

// ── FIXED: now returns FALSE for empty/blank strings
//    (the original returned true, silently passing '' as "valid")
function isValidURL(str) {
    if (!str || typeof str !== 'string') return false;
    const trimmed = str.trim();
    if (!trimmed) return false;           // ← was: return true
    try {
        const url      = new URL(trimmed);
        if (!['https:', 'http:'].includes(url.protocol)) return false;
        const hostname = url.hostname.toLowerCase();
        if ([
            'localhost', '127.0.0.1', '0.0.0.0',
            '::1', '169.254.169.254',
        ].includes(hostname)) return false;
        if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(hostname))
            return false;
        if (!hostname.includes('.')) return false;
        return true;
    } catch {
        return false;
    }
}

function isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    if (email.length > 254) return false;
    return /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/.test(email);
}

function isValidInteger(val, min, max) {
    const n = parseInt(String(val || ''), 10);
    if (isNaN(n)) return false;
    if (min !== undefined && n < min) return false;
    if (max !== undefined && n > max) return false;
    return true;
}

function truncate(str, maxLen = 500) {
    if (!str) return '';
    return String(str).trim().substring(0, maxLen);
}

// ════════════════════════════════════════════
// Rate Limiter
// ════════════════════════════════════════════
class RateLimiter {
    constructor(maxActions, windowMs, key) {
        this.maxActions = maxActions;
        this.windowMs   = windowMs;
        this._key       = key ? `_rl_${key}` : null;
    }

    _getActions() {
        if (!this._key) return [];
        try {
            const raw = sessionStorage.getItem(this._key);
            return raw ? JSON.parse(raw) : [];
        } catch { return []; }
    }

    _saveActions(actions) {
        if (!this._key) return;
        try { sessionStorage.setItem(this._key, JSON.stringify(actions)); } catch {}
    }

    canProceed() {
        const now     = Date.now();
        let   actions = this._getActions().filter(t => now - t < this.windowMs);
        if (actions.length >= this.maxActions) {
            this._saveActions(actions);
            return false;
        }
        actions.push(now);
        this._saveActions(actions);
        return true;
    }

    getWaitTime() {
        const now     = Date.now();
        const actions = this._getActions().filter(t => now - t < this.windowMs);
        if (actions.length < this.maxActions) return 0;
        return Math.max(0, this.windowMs - (now - actions[0]));
    }

    reset() {
        if (this._key) {
            try { sessionStorage.removeItem(this._key); } catch {}
        }
    }
}

// ════════════════════════════════════════════
// Secure Session
// ════════════════════════════════════════════
const SecureSession = {

    createSession(uid) {
        try {
            const token = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : Math.random().toString(36).slice(2) + Date.now().toString(36);
            sessionStorage.setItem('_dv_session_token',   token);
            sessionStorage.setItem('_dv_session_uid',     uid);
            sessionStorage.setItem('_dv_session_created', Date.now().toString());
            return token;
        } catch(e) { return ''; }
    },

    hasActiveSession(uid) {
        try {
            const token   = sessionStorage.getItem('_dv_session_token');
            const sessUid = sessionStorage.getItem('_dv_session_uid');
            const created = parseInt(sessionStorage.getItem('_dv_session_created') || '0', 10);
            if (!token || !sessUid)    return false;
            if (sessUid !== uid)       return false;
            if (Date.now() - created > 8 * 60 * 60 * 1000) {
                this.clear();
                return false;
            }
            return true;
        } catch(e) { return false; }
    },

    setUserData(data) {
        try {
            const sanitized = {
                uid:   sanitizeInput(data.uid   || '', 128),
                name:  sanitizeInput(data.name  || '', 100),
                email: sanitizeInput(data.email || '', 254),
                role:  ['admin', 'writer'].includes(data.role) ? data.role : 'writer',
            };
            sessionStorage.setItem('_dv_user', JSON.stringify({
                data:      sanitized,
                timestamp: Date.now(),
                checksum:  this._checksum(sanitized),
            }));
        } catch (e) {}
    },

    getUserData() {
        try {
            const raw = sessionStorage.getItem('_dv_user');
            if (!raw) return null;
            const payload = JSON.parse(raw);
            if (!payload?.data || !payload.timestamp || !payload.checksum) {
                this.clear(); return null;
            }
            if (payload.checksum !== this._checksum(payload.data)) {
                this.clear(); return null;
            }
            if (Date.now() - payload.timestamp > 8 * 60 * 60 * 1000) {
                this.clear(); return null;
            }
            return payload.data;
        } catch (e) {
            this.clear(); return null;
        }
    },

    setPendingVerification(data) {
        try {
            sessionStorage.setItem('_dv_pending', JSON.stringify({
                email: sanitizeInput(data.email || '', 254),
                name:  sanitizeInput(data.name  || '', 100),
            }));
        } catch (e) {}
    },

    getPendingVerification() {
        try {
            const raw = sessionStorage.getItem('_dv_pending');
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    },

    clear() {
        try {
            [
                '_dv_user', '_dv_pending', 'userData',
                'pendingVerification', '_dv_session_token',
                '_dv_session_uid', '_dv_session_created',
            ].forEach(k => sessionStorage.removeItem(k));
        } catch (e) {}
    },

    _checksum(data) {
        const str  = `${data.uid}|${data.email}|${data.role}|${data.name}`;
        let   hash = 5381;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
            hash = hash >>> 0;
        }
        return 'cs2_' + hash.toString(36);
    },
};

// ════════════════════════════════════════════
// Exports
// ════════════════════════════════════════════
const WORKER_URL = WORKER_BASE_URL;

export {
    auth, db, ensureInitialized, WORKER_URL,

    // Auth
    onAuthStateChanged, signInWithEmailAndPassword,
    createUserWithEmailAndPassword, signOut,
    sendEmailVerification, sendPasswordResetEmail,

    // Firestore
    doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
    collection, query, where, orderBy, limit,
    onSnapshot, writeBatch, serverTimestamp,
    Timestamp, arrayUnion, arrayRemove,

    // Writer history
    buildWriterChangeEntry, markHistoryAsSeen,
    hasUnseenWriterChange, getWriterChangeHistory,

    // Utils
    getIdToken, sanitizeHTML, sanitizeInput,
    isValidURL, isValidEmail, isValidInteger,
    truncate, RateLimiter, SecureSession,
};