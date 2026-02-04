# Project Commands

Run all commands through `sk exec`:

```bash
sk exec npm start
sk exec npm test
sk exec python script.py
sk exec ./deploy.sh
sk exec docker-compose up
```

Check available environment variables:
```bash
sk status
```

If a command fails due to missing environment variable, tell the user which variable is needed and ask them to configure it.

If `sk exec` says the daemon isn't running, ask the user to start it.
