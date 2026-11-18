// Spam control for the public intake forms (website inquiries and career interest).
// - Honeypot: a hidden field named website_url. Real visitors leave it empty; bots that fill every field trip it.
//   A tripped honeypot is refused before anything is saved, so no lead is created and no acknowledgement is sent.
// - Per-IP limit: at most INTAKE_RATE_LIMIT posts per IP per 15 minutes (default 20), across these forms.
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.INTAKE_RATE_LIMIT) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this network. Please try again in a few minutes.' }
});

const isBot = body => String((body && body.website_url) || '').trim() !== '';

module.exports = { limiter, isBot };
