const app = require('./app');
const { init } = require('./schema');

async function start() {
  for (let i = 1; i <= 15; i++) {
    try {
      await init(app.pool);
      break;
    } catch (e) {
      console.log(JSON.stringify({ level: 'warn', event: 'db_wait', attempt: i, message: e.message }));
      if (i === 15) process.exit(1);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(JSON.stringify({ level: 'info', event: 'server_started', port })));
}
start();
