const { spawn } = require('child_process');

const PROCESS_DEFINITIONS = {
    api: {
        command: process.execPath,
        args: ['backend/comments/server.js'],
        required: true,
    },
    'oracle-tech': {
        command: process.execPath,
        args: ['relayer/tech-oracle.js'],
        required: false,
    },
};

const requestedProcesses = String(process.env.RAILWAY_PROCESSES || 'api,oracle-tech')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const children = new Map();
let shuttingDown = false;

for (const name of requestedProcesses) {
    if (!PROCESS_DEFINITIONS[name]) {
        console.warn(`[railway] Unknown process "${name}" ignored.`);
        continue;
    }
    startProcess(name);
}

if (children.size === 0) {
    console.error('[railway] No known processes were requested.');
    process.exit(1);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function startProcess(name) {
    const definition = PROCESS_DEFINITIONS[name];
    const child = spawn(definition.command, definition.args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    children.set(name, child);
    console.log(`[railway] Started ${name} pid=${child.pid}`);

    child.stdout.on('data', (chunk) => process.stdout.write(prefixLines(name, chunk)));
    child.stderr.on('data', (chunk) => process.stderr.write(prefixLines(name, chunk)));

    child.on('exit', (code, signal) => {
        children.delete(name);
        if (shuttingDown) return;

        console.error(`[railway] ${name} exited with code=${code} signal=${signal || ''}`);
        if (definition.required) {
            shutdown();
            process.exit(code || 1);
            return;
        }

        setTimeout(() => startProcess(name), 5_000);
    });
}

function prefixLines(name, chunk) {
    return String(chunk)
        .split(/\r?\n/)
        .map((line, index, lines) => (index === lines.length - 1 && line === '' ? '' : `[${name}] ${line}`))
        .join('\n');
}

function shutdown() {
    shuttingDown = true;
    for (const child of children.values()) {
        child.kill('SIGTERM');
    }
}
