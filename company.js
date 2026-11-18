// Single source of truth for the company name shown to customers.
// Customer-facing emails, texts, PDFs and phone lines read the name from here.
// Set COMPANY_NAME in the environment to override it.
module.exports = {
  COMPANY_NAME: process.env.COMPANY_NAME || 'Bright Cleaning Sev Inc.',
  COMPANY_SHORT: 'Bright Cleaning',
};
