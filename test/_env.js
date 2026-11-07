process.env.APP_SECRET = 'test-secret-'.padEnd(48, 'x');
process.env.BASE_URL = 'https://app.buildintel.test';
process.env.SCHEDULER = 'off';
process.env.LOGIN_RATE_LIMIT = process.env.LOGIN_RATE_LIMIT || '1000'; // tests sign in many times; the brute-force test sets the production default explicitly
