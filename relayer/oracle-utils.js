const DEFAULT_CREATION_COOLDOWN_MS = Number(process.env.ORACLE_CREATION_COOLDOWN_MS || 30 * 60 * 1000);
const DEFAULT_MAX_STARTUP_DELAY_MS = Number(process.env.ORACLE_MAX_STARTUP_DELAY_MS || 90 * 1000);
const DEFAULT_BACKOFF_BASE_MS = Number(process.env.ORACLE_BACKOFF_BASE_MS || 2_000);
const DEFAULT_BACKOFF_MAX_MS = Number(process.env.ORACLE_BACKOFF_MAX_MS || 60_000);
const DEFAULT_BACKOFF_RETRIES = Number(process.env.ORACLE_BACKOFF_RETRIES || 2);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const hashString = value => {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
};

const errorMessage = error => (error && error.message ? error.message : String(error));

const isRateLimit = error => {
  const status = error?.response?.status;
  const message = errorMessage(error);
  return status === 429 || /too many requests|rate.?limit|-32005/i.test(message);
};

const isTransient = error => {
  const code = error?.code;
  const status = error?.response?.status;
  const message = errorMessage(error);
  return (
    isRateLimit(error) ||
    status === 408 ||
    status === 425 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    code === "TIMEOUT" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    /timeout|econnreset|enotfound|ehostunreach|missing response/i.test(message)
  );
};

async function withBackoff(label, operation, options = {}) {
  const retries = options.retries ?? DEFAULT_BACKOFF_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BACKOFF_BASE_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_BACKOFF_MAX_MS;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const retryable = isTransient(error);
      if (!retryable || attempt === retries) {
        throw error;
      }

      const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const jitter = Math.floor(Math.random() * Math.min(1_000, exponentialDelay));
      const delay = exponentialDelay + jitter;
      console.warn(`[BACKOFF] ${label} failed: ${errorMessage(error)}. Retrying in ${delay}ms.`);
      await sleep(delay);
    }
  }
}

function createCooldownCache(name, cooldownMs = DEFAULT_CREATION_COOLDOWN_MS) {
  const failures = new Map();

  return {
    shouldSkip(id) {
      const retryAt = failures.get(String(id));
      if (!retryAt) return false;
      if (Date.now() >= retryAt) {
        failures.delete(String(id));
        return false;
      }

      const seconds = Math.ceil((retryAt - Date.now()) / 1000);
      console.log(`[COOLDOWN] ${name} market ${id} skipped for ${seconds}s after a failed create attempt.`);
      return true;
    },
    markFailure(id, error) {
      failures.set(String(id), Date.now() + cooldownMs);
      console.warn(`[COOLDOWN] ${name} market ${id} create failed: ${errorMessage(error)}. Cooling down for ${Math.round(cooldownMs / 1000)}s.`);
    },
    clear(id) {
      failures.delete(String(id));
    },
  };
}

function startStaggeredLoop(name, intervalMs, task, options = {}) {
  const maxStartupDelayMs = options.maxStartupDelayMs ?? DEFAULT_MAX_STARTUP_DELAY_MS;
  const startupDelayMs =
    options.startupDelayMs ?? (maxStartupDelayMs > 0 ? hashString(name) % maxStartupDelayMs : 0);
  let running = false;

  const run = async () => {
    if (running) {
      console.warn(`[LOOP] ${name} skipped because the previous run is still active.`);
      return;
    }

    running = true;
    try {
      await task();
    } catch (error) {
      console.error(`[LOOP ERROR] ${name}:`, errorMessage(error));
    } finally {
      running = false;
    }
  };

  console.log(`[LOOP] ${name} starts in ${Math.round(startupDelayMs / 1000)}s, interval ${Math.round(intervalMs / 1000)}s.`);
  setTimeout(() => {
    run();
    setInterval(run, intervalMs);
  }, startupDelayMs);
}

module.exports = {
  createCooldownCache,
  errorMessage,
  startStaggeredLoop,
  withBackoff,
};
