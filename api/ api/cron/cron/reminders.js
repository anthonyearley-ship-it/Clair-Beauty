// api/cron/reminders.js
// Runs daily at 19:00 UTC via Vercel Cron.
// Checks two things:
//   1. Skin log reminders — based on each user's reminder_frequency preference
//   2. Product check-in emails — based on each user's checkin_interval_days preference
//
// Requires env vars:
//   CRON_SECRET          — a random string you set in Vercel; protects this endpoint
//   SUPABASE_URL         — your Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY — service role key (bypasses RLS so we can read all profiles)
//   RESEND_API_KEY       — for sending emails via /api/chat

export default async function handler(req, res) {
  // ── SECURITY: only allow Vercel cron calls (or your own calls with the secret) ──
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  const headers = {
    'Content-Type': 'application/json',
    'apikey': SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`
  };

  const now = new Date();
  const today = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
  const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase(); // "monday" etc.

  let remindersCount = 0;
  let checkinsCount  = 0;
  const errors = [];

  try {
    // ── FETCH ALL PROFILES WITH EMAIL + PREFERENCES ──────────────────────────
    // We join auth.users via email stored in profiles.
    // Service role key lets us read all rows regardless of RLS.
    const profilesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?select=id,email,name,report,report_date,reminder_frequency,reminder_day,checkin_interval_days,last_reminder_sent,last_checkin_sent,concern,budget&reminder_frequency=neq.off`,
      { headers }
    );
    const profiles = await profilesRes.json();

    if (!Array.isArray(profiles)) {
      return res.status(500).json({ error: 'Failed to fetch profiles', detail: profiles });
    }

    for (const profile of profiles) {
      const email = profile.email;
      if (!email || email.startsWith('pending_')) continue;

      // ── 1. SKIN LOG REMINDER ────────────────────────────────────────────────
      const shouldRemind = checkReminderDue(profile, dayOfWeek, today);

      if (shouldRemind) {
        try {
          // Fetch this user's skin log entries (last 5)
          const logRes = await fetch(
            `${SUPABASE_URL}/rest/v1/skin_log?user_id=eq.${profile.id}&order=created_at.desc&limit=5`,
            { headers }
          );
          const entries = await logRes.json();

          // Calculate streak (weeks with at least one entry)
          const streak = await calculateStreak(profile.id, SUPABASE_URL, headers);

          // Calculate average rating this month
          const avg_rating = averageRating(entries);

          // Send reminder email via our /api/chat endpoint
          const reminderRes = await fetch(`${getBaseUrl(req)}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'send_reminder',
              to: email,
              name: profile.name || '',
              entries: Array.isArray(entries) ? entries : [],
              streak,
              avg_rating
            })
          });

          if (reminderRes.ok) {
            // Update last_reminder_sent
            await fetch(
              `${SUPABASE_URL}/rest/v1/profiles?id=eq.${profile.id}`,
              {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ last_reminder_sent: now.toISOString() })
              }
            );
            remindersCount++;
          }
        } catch (e) {
          errors.push(`Reminder for ${email}: ${e.message}`);
        }
      }

      // ── 2. PRODUCT CHECK-IN ──────────────────────────────────────────────────
      const shouldCheckin = checkCheckinDue(profile, today);

      if (shouldCheckin && profile.report) {
        try {
          // Extract products from stored report HTML
          const products = extractProductsFromReportHtml(profile.report);
          const reportDate = profile.report_date ? new Date(profile.report_date) : null;
          const daysSinceReport = reportDate
            ? Math.floor((now - reportDate) / (1000 * 60 * 60 * 24))
            : null;

          const checkinRes = await fetch(`${getBaseUrl(req)}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'send_checkin',
              to: email,
              name: profile.name || '',
              products,
              days_since_report: daysSinceReport
            })
          });

          if (checkinRes.ok) {
            await fetch(
              `${SUPABASE_URL}/rest/v1/profiles?id=eq.${profile.id}`,
              {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ last_checkin_sent: now.toISOString() })
              }
            );
            checkinsCount++;
          }
        } catch (e) {
          errors.push(`Checkin for ${email}: ${e.message}`);
        }
      }
    }

    return res.status(200).json({
      ok: true,
      date: today,
      reminders_sent: remindersCount,
      checkins_sent: checkinsCount,
      errors: errors.length ? errors : undefined
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Returns true if it's the right day/interval and we haven't sent one recently
function checkReminderDue(profile, dayOfWeek, today) {
  const freq = profile.reminder_frequency || 'weekly';
  const preferredDay = profile.reminder_day || 'sunday';
  const lastSent = profile.last_reminder_sent ? new Date(profile.last_reminder_sent) : null;

  if (freq === 'off') return false;

  // Is today the right day of the week?
  if (dayOfWeek !== preferredDay) return false;

  if (!lastSent) return true;

  const daysSinceLast = (new Date() - lastSent) / (1000 * 60 * 60 * 24);

  if (freq === 'weekly')      return daysSinceLast >= 6;
  if (freq === 'fortnightly') return daysSinceLast >= 13;
  if (freq === 'monthly')     return daysSinceLast >= 27;

  return false;
}

// Returns true if the check-in interval has elapsed
function checkCheckinDue(profile, today) {
  const interval = profile.checkin_interval_days;
  if (!interval || interval === 0) return false;
  if (!profile.report) return false;

  const lastSent = profile.last_checkin_sent ? new Date(profile.last_checkin_sent) : null;
  const reportDate = profile.report_date ? new Date(profile.report_date) : null;

  // Start counting from whenever the report was generated
  const reference = lastSent || reportDate;
  if (!reference) return false;

  const daysSince = (new Date() - reference) / (1000 * 60 * 60 * 24);
  return daysSince >= interval;
}

// Fetch 90 days of log entries, count distinct weeks that had at least one entry
async function calculateStreak(userId, supabaseUrl, headers) {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 90);
    const logRes = await fetch(
      `${supabaseUrl}/rest/v1/skin_log?user_id=eq.${userId}&created_at=gte.${since.toISOString()}&order=created_at.desc`,
      { headers }
    );
    const entries = await logRes.json();
    if (!Array.isArray(entries) || entries.length === 0) return 0;

    // Group by ISO week number
    const weeks = new Set(entries.map(e => {
      const d = new Date(e.created_at);
      const jan1 = new Date(d.getFullYear(), 0, 1);
      return Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
    }));
    return weeks.size;
  } catch {
    return 0;
  }
}

// Compute average rating label from entries
function averageRating(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const scores = { struggling: 1, rough: 2, okay: 3, good: 4, glowing: 5 };
  const labels = ['', 'Struggling', 'Rough', 'Okay', 'Good', 'Glowing'];
  const total = entries.reduce((sum, e) => sum + (scores[e.rating] || 3), 0);
  const avg = Math.round(total / entries.length);
  return labels[avg] || null;
}

// Extract Amazon product links from stored report HTML using simple regex
// (No DOM parser available in Node.js without extra deps)
function extractProductsFromReportHtml(html) {
  if (!html) return [];
  const products = [];
  const regex = /<a[^>]+href="(https:\/\/www\.amazon\.com[^"]+)"[^>]*>([^<]+)<\/a>/gi;
  let match;
  const seen = new Set();
  while ((match = regex.exec(html)) !== null) {
    const href = match[1];
    const name = match[2].trim();
    if (name && href && !seen.has(name)) {
      seen.add(name);
      products.push({ name, href });
    }
  }
  return products;
}

// Derive the base URL from the request (works on Vercel)
function getBaseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'www.clairbeautyco.com';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}
