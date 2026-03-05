// ============================================
// email-service.js
// Shared email sending utility
// FIXED: proper getIdToken usage, validation,
//        timeout, retry logic, and debug logging
// ============================================

import { WORKER_URL, getIdToken, sanitizeInput, isValidEmail } from './firebase.js';

// ── Constants ──────────────────────────────────────────────────────────────
const EMAIL_TIMEOUT_MS = 10_000;   // 10 s per attempt
const EMAIL_MAX_RETRY  = 2;        // total attempts
const MIN_TOKEN_LENGTH = 100;      // JWT sanity check

// Valid email type whitelist — prevents arbitrary endpoint calls
const VALID_EMAIL_TYPES = new Set([
    'show-assigned',
    'new-remark-to-writer',
    'new-remark-to-admin',
    'writer-registered',
    'password-reset-confirm',
]);

// ── Internal: fetch with timeout ───────────────────────────────────────────
async function _fetchWithTimeout(url, options, timeoutMs = EMAIL_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timer);
        return resp;
    } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') throw new Error(`Email request timed out after ${timeoutMs}ms`);
        throw e;
    }
}

// ── Internal: get a valid token or throw ───────────────────────────────────
async function _getValidToken() {
    // getIdToken now handles ensureInitialized() internally (fixed in firebase.js)
    const token = await getIdToken(false);

    if (!token || typeof token !== 'string') {
        throw new Error('getIdToken returned empty value');
    }
    if (token.length < MIN_TOKEN_LENGTH) {
        throw new Error(`Token too short (${token.length} chars) — likely invalid`);
    }
    // Quick JWT structure check: must be three base64url parts
    if (token.split('.').length !== 3) {
        throw new Error('Token is not a valid JWT structure');
    }
    return token;
}

// ── Core sender with retry ─────────────────────────────────────────────────
/**
 * Send an email notification via the Cloudflare Worker → Resend.
 * Fails silently after all retries — never blocks the main action.
 *
 * @param {string} type  - one of VALID_EMAIL_TYPES
 * @param {object} data  - payload for the specific email template
 * @returns {Promise<{success:boolean, error?:string}>}
 */
export async function sendEmailNotification(type, data) {
    // ── Validate type ──────────────────────────────────────────────────────
    if (!type || !VALID_EMAIL_TYPES.has(type)) {
        console.warn(`[Email] Unknown email type "${type}" — skipped`);
        return { success: false, error: `Unknown email type: ${type}` };
    }

    // ── Validate WORKER_URL ────────────────────────────────────────────────
    if (!WORKER_URL || typeof WORKER_URL !== 'string' || !WORKER_URL.startsWith('https://')) {
        console.error('[Email] WORKER_URL is not set or invalid — cannot send email');
        return { success: false, error: 'WORKER_URL not configured' };
    }

    const endpoint = `${WORKER_URL}/api/send-email`;
    let   lastError = '';

    for (let attempt = 1; attempt <= EMAIL_MAX_RETRY; attempt++) {
        try {
            // ── Get fresh token each attempt ───────────────────────────────
            // Pass forceRefresh=true on the retry so we don't reuse a stale token
            const token = attempt === 1
                ? await _getValidToken()
                : await getIdToken(true);

            if (!token || token.length < MIN_TOKEN_LENGTH) {
                throw new Error('Could not obtain a valid ID token');
            }

            console.log(`[Email] Sending "${type}" (attempt ${attempt})`);

            const resp = await _fetchWithTimeout(
                endpoint,
                {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ type, idToken: token, data }),
                    // no credentials — worker doesn't need cookies
                    credentials: 'omit',
                },
                EMAIL_TIMEOUT_MS
            );

            // ── Parse response ─────────────────────────────────────────────
            const text   = await resp.text().catch(() => '');
            let   result = { success: false };
            try { result = JSON.parse(text); } catch (_) {
                // Non-JSON body — treat 2xx as success
                result = { success: resp.ok };
            }

            if (!resp.ok) {
                const errMsg = result?.error || result?.message || `HTTP ${resp.status}`;
                console.warn(`[Email] Attempt ${attempt} failed: ${errMsg}`);
                lastError = errMsg;

                // Don't retry 4xx errors (bad request, unauthorised, etc.)
                if (resp.status >= 400 && resp.status < 500) break;
                continue;
            }

            // ── Success ────────────────────────────────────────────────────
            console.log(`[Email] ✅ "${type}" sent successfully`);
            return { success: true, ...result };

        } catch (e) {
            lastError = e.message || String(e);
            console.warn(`[Email] Attempt ${attempt} exception:`, lastError);

            // Abort immediately for auth errors — retrying won't help
            if (
                lastError.includes('No authenticated user') ||
                lastError.includes('not initialized')       ||
                lastError.includes('Invalid user object')
            ) {
                break;
            }

            // Small back-off before next retry
            if (attempt < EMAIL_MAX_RETRY) {
                await new Promise(r => setTimeout(r, 500 * attempt));
            }
        }
    }

    console.warn(`[Email] ❌ All attempts failed for "${type}":`, lastError);
    return { success: false, error: lastError };
}

// ════════════════════════════════════════════════════════════════════════════
// Typed helpers — validate required fields before calling sendEmailNotification
// ════════════════════════════════════════════════════════════════════════════

/**
 * Notify writer that a show has been assigned to them
 *
 * @param {{ show: object, adminEmail: string }} params
 */
export async function notifyShowAssigned({ show, adminEmail }) {
    // Guard: writer must have an email
    if (!show?.writerEmail || !isValidEmail(show.writerEmail)) {
        console.warn('[Email] notifyShowAssigned: missing or invalid writerEmail — skipped');
        return { success: false, error: 'Missing writerEmail' };
    }

    return sendEmailNotification('show-assigned', {
        writerEmail:     sanitizeInput(show.writerEmail,            254),
        writerName:      sanitizeInput(show.assignedTo             || show.writerEmail.split('@')[0], 100),
        showCode:        sanitizeInput(show.showCode               || '', 50),
        showName:        sanitizeInput(show.showOgName             || show.showEnglishName || '', 200),
        showWorkingName: sanitizeInput(show.showEnglishName        || '', 200),
        language:        sanitizeInput(show.language               || '', 10),
        showType:        sanitizeInput(show.showType               || '', 10),
        adminEmail:      sanitizeInput(adminEmail                  || '', 254),
    });
}

/**
 * Notify writer of a new admin remark
 *
 * @param {{ show: object, messageText: string, adminName: string, adminEmail: string }} params
 */
export async function notifyRemarkToWriter({ show, messageText, adminName, adminEmail }) {
    if (!show?.writerEmail || !isValidEmail(show.writerEmail)) {
        console.warn('[Email] notifyRemarkToWriter: missing or invalid writerEmail — skipped');
        return { success: false, error: 'Missing writerEmail' };
    }
    if (!messageText || typeof messageText !== 'string' || !messageText.trim()) {
        console.warn('[Email] notifyRemarkToWriter: empty messageText — skipped');
        return { success: false, error: 'Empty message text' };
    }

    const remarks = Array.isArray(show.remarks) ? show.remarks : [];

    return sendEmailNotification('new-remark-to-writer', {
        writerEmail:    sanitizeInput(show.writerEmail,                                    254),
        writerName:     sanitizeInput(show.assignedTo || show.writerEmail.split('@')[0],   100),
        showCode:       sanitizeInput(show.showCode   || '',                                50),
        showName:       sanitizeInput(show.showOgName || show.showEnglishName || '',       200),
        adminName:      sanitizeInput(adminName       || 'Your Admin',                     100),
        adminEmail:     sanitizeInput(adminEmail      || '',                               254),
        messagePreview: sanitizeInput(messageText,                                         200),
        totalMessages:  remarks.length + 1,
    });
}

/**
 * Notify admin of a new writer remark
 *
 * @param {{ show: object, messageText: string, writerName: string, writerEmail: string, adminEmail: string }} params
 */
export async function notifyRemarkToAdmin({ show, messageText, writerName, writerEmail, adminEmail }) {
    if (!adminEmail || !isValidEmail(adminEmail)) {
        console.warn('[Email] notifyRemarkToAdmin: missing or invalid adminEmail — skipped');
        return { success: false, error: 'Missing adminEmail' };
    }
    if (!messageText || typeof messageText !== 'string' || !messageText.trim()) {
        console.warn('[Email] notifyRemarkToAdmin: empty messageText — skipped');
        return { success: false, error: 'Empty message text' };
    }

    const remarks = Array.isArray(show?.remarks) ? show.remarks : [];

    return sendEmailNotification('new-remark-to-admin', {
        adminEmail:     sanitizeInput(adminEmail                                                  || '', 254),
        adminName:      'Admin',
        showCode:       sanitizeInput(show?.showCode                                              || '',  50),
        showName:       sanitizeInput(show?.showOgName || show?.showEnglishName                  || '', 200),
        writerName:     sanitizeInput(writerName       || show?.assignedTo                       || '', 100),
        writerEmail:    sanitizeInput(writerEmail      || show?.writerEmail                      || '', 254),
        messagePreview: sanitizeInput(messageText,                                                     200),
        totalMessages:  remarks.length + 1,
    });
}