const fs = require('fs');
const { execFileSync } = require('child_process');

function run(args) {
  console.log(`RUN n8n ${args.join(' ')}`);
  execFileSync('n8n', args, { stdio: 'inherit', env: process.env });
}

async function main() {
  if (!process.env.MOTAJA_WORKFLOW_B64) throw new Error('MOTAJA_WORKFLOW_B64 missing');
  const workflowPath = '/tmp/motaja-workflow.json';
  fs.writeFileSync(workflowPath, Buffer.from(process.env.MOTAJA_WORKFLOW_B64, 'base64'));

  try {
    run(['import:workflow', `--input=${workflowPath}`]);
  } catch (error) {
    console.log('Import failed once; workflow may already exist.');
  }

  let published = false;
  for (const args of [
    ['publish:workflow', '--id=motaja-wa-v1'],
    ['update:workflow', '--id=motaja-wa-v1', '--active=true'],
  ]) {
    try {
      run(args);
      published = true;
      break;
    } catch (error) {
      console.log(`Activation command failed: n8n ${args.join(' ')}`);
    }
  }
  if (!published) throw new Error('Could not publish/activate motaja-wa-v1');

  const response = await fetch(`${process.env.EVOLUTION_API_URL}/webhook/set/motaja`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: process.env.EVOLUTION_API_KEY,
    },
    body: JSON.stringify({
      webhook: {
        enabled: true,
        url: 'https://n8n-production-4cf1.up.railway.app/webhook/motaja-whatsapp',
        byEvents: false,
        base64: false,
        events: ['MESSAGES_UPSERT'],
      },
    }),
  });
  const text = await response.text();
  console.log(`MOTAJA_WEBHOOK_STATUS=${response.status}`);
  if (!response.ok) {
    console.error(text.slice(0, 500));
    throw new Error('Evolution webhook configuration failed');
  }

  console.log('MOTAJA_BOOTSTRAP_COMPLETE');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
