// email-service.js
// Shared email sending utility for both admin and writer dashboards

import { WORKER_URL, getIdToken } from './firebase.js';

/**
 * Send an email notification via the Cloudflare Worker → Resend
 * Fails silently — never blocks the main action
 */
export async function sendEmailNotification(type, data) {
  try {
    let idToken = '';
    try {
      idToken = await getIdToken(true);
    } catch (_) {
      return { success: false, error: 'No auth token' };
    }

    if (!idToken) return { success: false, error: 'No token' };

    const resp = await fetch(`${WORKER_URL}/api/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, idToken, data }),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.warn('[Email] Failed:', resp.status, txt);
      return { success: false, error: `HTTP ${resp.status}` };
    }

    const result = await resp.json().catch(() => ({ success: true }));
    return result;
  } catch (e) {
    console.warn('[Email] Exception:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Notify writer that a show has been assigned to them
 */
export async function notifyShowAssigned({ show, adminEmail }) {
  if (!show?.writerEmail) return;
  return sendEmailNotification('show-assigned', {
    writerEmail:    show.writerEmail,
    writerName:     show.assignedTo || show.writerEmail.split('@')[0],
    showCode:       show.showCode   || '',
    showName:       show.showOgName || show.showEnglishName || '',
    showWorkingName: show.showEnglishName || '',
    language:       show.language   || '',
    showType:       show.showType   || '',
    adminEmail:     adminEmail      || '',
  });
}

/**
 * Notify writer of a new admin remark
 */
export async function notifyRemarkToWriter({ show, messageText, adminName, adminEmail }) {
  if (!show?.writerEmail) return;
  const remarks = Array.isArray(show.remarks) ? show.remarks : [];
  return sendEmailNotification('new-remark-to-writer', {
    writerEmail:     show.writerEmail,
    writerName:      show.assignedTo || show.writerEmail.split('@')[0],
    showCode:        show.showCode   || '',
    showName:        show.showOgName || show.showEnglishName || '',
    adminName:       adminName       || 'Your Admin',
    adminEmail:      adminEmail      || '',
    messagePreview:  (messageText || '').substring(0, 200),
    totalMessages:   remarks.length + 1,
  });
}

/**
 * Notify admin of a new writer remark
 */
export async function notifyRemarkToAdmin({ show, messageText, writerName, writerEmail, adminEmail }) {
  if (!adminEmail) return;
  const remarks = Array.isArray(show.remarks) ? show.remarks : [];
  return sendEmailNotification('new-remark-to-admin', {
    adminEmail:     adminEmail  || '',
    adminName:      'Admin',
    showCode:       show.showCode   || '',
    showName:       show.showOgName || show.showEnglishName || '',
    writerName:     writerName  || show.assignedTo || '',
    writerEmail:    writerEmail || show.writerEmail || '',
    messagePreview: (messageText || '').substring(0, 200),
    totalMessages:  remarks.length + 1,
  });
}