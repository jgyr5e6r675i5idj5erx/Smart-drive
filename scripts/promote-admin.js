require('dotenv').config();
const { MongoClient } = require('mongodb');
(async () => {
  const email = (process.argv[2] || '').trim().toLowerCase();
  if (!email) {
    console.error('Usage: node scripts/promote-admin.js your-registered-email@example.com');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is missing. Set it in your local .env first.');
    process.exit(1);
  }
  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || 'smart_ride');
    const result = await db.collection('users').updateOne({ email }, { $set: { role: 'admin' } });
    if (!result.matchedCount) {
      console.error('No account found for that email. Register on SMART RIDE first, then run this command.');
      process.exitCode = 1;
    } else {
      console.log(`Admin access granted to ${email}. Log out and log back in to refresh the session.`);
    }
  } finally {
    await client.close();
  }
})().catch(err => { console.error(err); process.exit(1); });
