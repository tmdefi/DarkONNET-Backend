const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const localForge = path.join(__dirname, '..', process.platform === 'win32' ? 'forge.exe' : 'forge');
const command = fs.existsSync(localForge) ? localForge : 'forge';
const result = spawnSync(command, process.argv.slice(2), { stdio: 'inherit' });

if (result.error) {
    console.error(result.error.message);
    process.exit(1);
}

process.exit(result.status ?? 1);
