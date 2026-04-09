export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { type, messages, system, model, max_tokens, email, subject, html } = req.body;

  // ── SEND EMAIL (generic) ──────────────────────────────────────────────────
  if (type === 'send_email') {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
        },
        body: JSON.stringify({
          from: 'Clair <clair@clairbeautyco.com>',
          to: email,
          subject: subject,
          html: html
        })
      });
      const data = await response.json();
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: { message: err.message } });
    }
  }

  // ── SEND SKIN LOG REMINDER EMAIL ──────────────────────────────────────────
  // Called by the cron job or manually. Receives pre-built HTML.
  if (type === 'send_reminder') {
    const { to, name, entries, streak, avg_rating } = req.body;
    try {
      const emailHtml = buildReminderEmail({ name, entries, streak, avg_rating });
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
        },
        body: JSON.stringify({
          from: 'Clair <clair@clairbeautyco.com>',
          to: to,
          subject: `${name ? name + ', your' : 'Your'} skin journal is waiting`,
          html: emailHtml
        })
      });
      const data = await response.json();
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: { message: err.message } });
    }
  }

  // ── SEND PRODUCT CHECK-IN EMAIL ───────────────────────────────────────────
  if (type === 'send_checkin') {
    const { to, name, products, days_since_report } = req.body;
    try {
      const emailHtml = buildCheckinEmail({ name, products, days_since_report });
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
        },
        body: JSON.stringify({
          from: 'Clair <clair@clairbeautyco.com>',
          to: to,
          subject: `How are your products working, ${name || 'lovely'}?`,
          html: emailHtml
        })
      });
      const data = await response.json();
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: { message: err.message } });
    }
  }

  // ── CLAUDE API CALL ───────────────────────────────────────────────────────
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model, max_tokens, system, messages })
    });
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL BUILDERS
// These live server-side so they never bloat the frontend bundle.
// ─────────────────────────────────────────────────────────────────────────────

const RATING_LABELS = {
  struggling: { emoji: '😔', label: 'Struggling', color: '#c0392b' },
  rough:      { emoji: '😕', label: 'Rough',      color: '#e67e22' },
  okay:       { emoji: '😐', label: 'Okay',       color: '#8A7E74' },
  good:       { emoji: '🙂', label: 'Good',       color: '#7CB987' },
  glowing:    { emoji: '✨', label: 'Glowing',    color: '#C9A96E' }
};

function ratingScore(r) {
  return { struggling: 1, rough: 2, okay: 3, good: 4, glowing: 5 }[r] || 3;
}

function buildReminderEmail({ name, entries = [], streak = 0, avg_rating }) {
  // Build a mini timeline of last 5 entries
  const recent = entries.slice(0, 5);

  const entriesHtml = recent.length > 0 ? recent.map(e => {
    const r = RATING_LABELS[e.rating] || RATING_LABELS.okay;
    const date = new Date(e.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const factors = e.factors && e.factors.length ? `<span style="font-size:11px;color:#8A7E74;margin-left:6px;">${e.factors.join(' · ')}</span>` : '';
    const note = e.note ? `<p style="font-size:13px;color:#8A7E74;margin:4px 0 0;font-style:italic;">"${e.note}"</p>` : '';
    return `
      <div style="padding:12px 0;border-bottom:1px solid rgba(201,169,110,0.15);">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:18px;">${r.emoji}</span>
          <span style="font-size:13px;font-weight:500;color:${r.color};">${r.label}</span>
          <span style="font-size:11px;color:#8A7E74;margin-left:auto;">${date}</span>
          ${factors}
        </div>
        ${note}
      </div>`;
  }).join('') : '<p style="font-size:13px;color:#8A7E74;font-style:italic;">No entries yet — today would be a great day to start.</p>';

  const streakHtml = streak > 1
    ? `<div style="background:rgba(201,169,110,0.08);border:1px solid rgba(201,169,110,0.2);padding:12px 16px;margin-bottom:20px;border-radius:2px;text-align:center;">
        <span style="font-size:20px;">🔥</span>
        <span style="font-size:13px;color:#C9A96E;margin-left:8px;">${streak}-week streak — your skin journal is working</span>
       </div>`
    : '';

  const avgHtml = avg_rating
    ? `<p style="font-size:13px;color:#8A7E74;text-align:center;margin-bottom:20px;">Your average this month: <strong style="color:#C9A96E;">${avg_rating}</strong></p>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#FAF7F2;font-family:Georgia,serif;">
<div style="max-width:560px;margin:0 auto;padding:40px 20px;">
  <div style="text-align:center;padding-bottom:24px;border-bottom:1px solid rgba(201,169,110,0.3);margin-bottom:28px;">
    <h1 style="font-family:Georgia,serif;font-size:32px;font-weight:300;letter-spacing:0.15em;color:#C9A96E;margin:0;">Clair</h1>
    <p style="font-size:9px;letter-spacing:0.4em;text-transform:uppercase;color:#8A7E74;margin:4px 0 0;">Skin Intelligence</p>
  </div>

  <h2 style="font-family:Georgia,serif;font-size:22px;font-weight:300;color:#2D2520;margin:0 0 8px;">
    ${name ? `How is your skin today, ${name}?` : 'How is your skin today?'}
  </h2>
  <p style="font-size:14px;color:#8A7E74;line-height:1.7;margin:0 0 24px;">
    Your skin journal is the most honest record of what's working — and what isn't. It only takes a moment.
  </p>

  ${streakHtml}
  ${avgHtml}

  <div style="margin-bottom:24px;">
    <p style="font-size:10px;letter-spacing:0.35em;text-transform:uppercase;color:#C9A96E;margin:0 0 12px;">Your Recent Entries</p>
    ${entriesHtml}
  </div>

  <div style="text-align:center;margin:28px 0;">
    <a href="https://www.clairbeautyco.com" style="display:inline-block;padding:14px 36px;background:#C9A96E;color:#1A1410;font-family:Arial,sans-serif;font-size:10px;letter-spacing:0.3em;text-transform:uppercase;text-decoration:none;font-weight:500;">Log Today's Skin</a>
  </div>

  <div style="border-top:1px solid rgba(201,169,110,0.2);margin-top:32px;padding-top:20px;">
    <p style="font-size:10px;color:#8A7E74;line-height:1.7;text-align:center;">
      You're receiving this because you asked Clair to send you skin log reminders.
      <br><a href="https://www.clairbeautyco.com" style="color:#C9A96E;">Update your preferences</a>
    </p>
  </div>
</div>
</body></html>`;
}

function buildCheckinEmail({ name, products = [], days_since_report }) {
  const productsHtml = products.length > 0 ? products.map(p => `
    <div style="padding:14px 16px;border:1px solid rgba(201,169,110,0.2);margin-bottom:10px;display:flex;align-items:center;gap:14px;">
      <span style="font-size:20px;">✦</span>
      <div style="flex:1;">
        <div style="font-family:Georgia,serif;font-size:15px;color:#2D2520;">${p.name}</div>
        <div style="font-size:11px;color:#8A7E74;margin-top:2px;">Recommended by Clair</div>
      </div>
      ${p.href ? `<a href="${p.href}" style="font-size:9px;letter-spacing:0.2em;text-transform:uppercase;color:#C9A96E;text-decoration:none;border:1px solid rgba(201,169,110,0.4);padding:6px 12px;white-space:nowrap;">View →</a>` : ''}
    </div>`).join('') : '<p style="font-size:13px;color:#8A7E74;font-style:italic;">Complete a consultation to get your personalized product list.</p>';

  const daysText = days_since_report ? `It's been about ${days_since_report} days since Clair built your report.` : 'It\'s been a little while since your last consultation.';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#FAF7F2;font-family:Georgia,serif;">
<div style="max-width:560px;margin:0 auto;padding:40px 20px;">
  <div style="text-align:center;padding-bottom:24px;border-bottom:1px solid rgba(201,169,110,0.3);margin-bottom:28px;">
    <h1 style="font-family:Georgia,serif;font-size:32px;font-weight:300;letter-spacing:0.15em;color:#C9A96E;margin:0;">Clair</h1>
    <p style="font-size:9px;letter-spacing:0.4em;text-transform:uppercase;color:#8A7E74;margin:4px 0 0;">Skin Intelligence</p>
  </div>

  <h2 style="font-family:Georgia,serif;font-size:22px;font-weight:300;color:#2D2520;margin:0 0 8px;">
    ${name ? `${name}, how are your products working?` : 'How are your products working?'}
  </h2>
  <p style="font-size:14px;color:#8A7E74;line-height:1.7;margin:0 0 24px;">
    ${daysText} Time to check in — are your recommended products living up to their promise?
  </p>

  <p style="font-size:10px;letter-spacing:0.35em;text-transform:uppercase;color:#C9A96E;margin:0 0 14px;">Your Recommended Products</p>
  ${productsHtml}

  <div style="background:#1A1410;padding:20px 24px;margin:24px 0;">
    <p style="font-family:Georgia,serif;font-size:16px;font-weight:300;color:#FAF7F2;margin:0 0 8px;">Ready for a new consultation?</p>
    <p style="font-size:13px;color:#8A7E74;line-height:1.65;margin:0 0 16px;">Your skin changes with the seasons, your hormones, and your life. Clair's recommendations evolve with you.</p>
    <a href="https://www.clairbeautyco.com" style="display:inline-block;padding:12px 28px;background:#C9A96E;color:#1A1410;font-family:Arial,sans-serif;font-size:10px;letter-spacing:0.3em;text-transform:uppercase;text-decoration:none;">Start a New Consultation</a>
  </div>

  <div style="border-top:1px solid rgba(201,169,110,0.2);margin-top:24px;padding-top:20px;">
    <p style="font-size:10px;color:#8A7E74;line-height:1.7;text-align:center;">
      You chose to receive product check-in reminders from Clair.
      <br><a href="https://www.clairbeautyco.com" style="color:#C9A96E;">Update your preferences</a>
    </p>
  </div>
</div>
</body></html>`;
}
