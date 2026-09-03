const fs = require('fs');
const { execFileSync } = require('child_process');

function run(args) {
  console.log(`RUN n8n ${args.join(' ')}`);
  execFileSync('n8n', args, { stdio: 'inherit', env: process.env });
}

function importWorkflow(envName, path, workflowId) {
  const encoded = process.env[envName];
  if (!encoded) return false;
  fs.writeFileSync(path, Buffer.from(encoded, 'base64'));
  try {
    run(['import:workflow', `--input=${path}`]);
  } catch (error) {
    console.log(`Import failed once for ${workflowId}; workflow may already exist.`);
  }
  for (const args of [
    ['publish:workflow', `--id=${workflowId}`],
    ['update:workflow', `--id=${workflowId}`, '--active=true'],
  ]) {
    try {
      run(args);
      return true;
    } catch (error) {
      console.log(`Activation command failed: n8n ${args.join(' ')}`);
    }
  }
  throw new Error(`Could not publish/activate ${workflowId}`);
}

async function main() {
  const importedMain = importWorkflow('MOTAJA_WORKFLOW_B64', '/tmp/motaja-workflow.json', 'motaja-wa-v1');
  const importedEvents = importWorkflow('MOTAJA_EVENTS_WORKFLOW_B64', '/tmp/motaja-events-workflow.json', 'motaja-wa-events-v1');
  if (!importedMain && !importedEvents) throw new Error('No MotaJa workflow payload supplied');

  if (process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY) {
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
  }

  console.log('MOTAJA_BOOTSTRAP_COMPLETE');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
