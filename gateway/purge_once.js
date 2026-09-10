const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const secret = String(process.env.MOTAJA_AGENT_GATEWAY_SECRET || '');
if (!base || !secret) {
  console.error('purge_once: missing Supabase URL or agent secret');
  process.exit(1);
}
const url = `${base}/functions/v1/motaja-purge-users-20260910`;
const response = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-motaja-agent-secret': secret,
  },
  body: JSON.stringify({ confirm: 'PURGE_NON_DRIVER_USERS_20260910' }),
});
const text = await response.text();
console.log('purge_once:', response.status, text);
if (!response.ok) process.exit(1);
