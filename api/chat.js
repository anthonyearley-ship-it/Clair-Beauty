export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { type, messages, system, model, max_tokens, email, subject, html } = req.body;

  // Email sending via Resend
  if (type === 'send_email') {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
        },
        body: JSON.stringify({
          from: 'Clair Beauty Intelligence <hello@clairbeautyco.com>',
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

  // Create Stripe checkout session
  if (type === 'create_checkout') {
    try {
      const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          'payment_method_types[]': 'card',
          'line_items[0][price]': process.env.STRIPE_PRICE_ID,
          'line_items[0][quantity]': '1',
          'mode': 'subscription',
          'success_url': `${req.body.origin}/success?session_id={CHECKOUT_SESSION_ID}`,
          'cancel_url': `${req.body.origin}/`,
          'customer_email': req.body.customerEmail || ''
        }).toString()
      });
      const data = await response.json();
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: { message: err.message } });
    }
  }

  // Verify Stripe session
  if (type === 'verify_session') {
    try {
      const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${req.body.sessionId}`, {
        headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` }
      });
      const data = await response.json();
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: { message: err.message } });
    }
  }

  // Claude API call
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
