module.exports = {
  apps: [
    {
      name: 'darkonnet-backend',
      script: 'backend/comments/server.js',
      env: {
        NODE_ENV: 'development',
        PORT: 8787
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 8787
      }
    },
    {
      name: 'oracle-esports',
      script: 'relayer/esports-oracle.js',
      restart_delay: 5000,
      max_restarts: 10
    },
    {
      name: 'oracle-sports',
      script: 'relayer/sports-oracle.js',
      restart_delay: 5000,
      max_restarts: 10
    },
    {
      name: 'oracle-crypto',
      script: 'relayer/crypto-oracle.js',
      restart_delay: 5000,
      max_restarts: 10
    },
    {
      name: 'oracle-politics',
      script: 'relayer/politics-oracle.js',
      restart_delay: 5000,
      max_restarts: 10
    },
    {
      name: 'oracle-tech',
      script: 'relayer/tech-oracle.js',
      restart_delay: 5000,
      max_restarts: 10
    },
    {
      name: 'oracle-finance-culture',
      script: 'relayer/finance-culture-oracle.js',
      restart_delay: 5000,
      max_restarts: 10
    }
  ]
};
