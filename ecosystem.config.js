module.exports = {
  apps: [
    {
      name: 'dhan-trading-bot',
      // Using 'npm start' is the standard way to launch Next.js production
      script: 'npm',
      args: 'start',
      // Declarative Environment Variables
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      // Restart logic
      instances: 1, // Keep it to 1 on a t3.nano
      autorestart: true,
      watch: false, // Don't watch files in production (saves CPU)
      // Memory Guardrail: Crucial for t3.nano (512MB RAM)
      // Restarts the app if it hits 400MB to prevent system OOM
      max_memory_restart: '400M',
      // Log management
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};