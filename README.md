# Mail Automation Operator Console

Local Windows operator console for the Hotmail to ElevenLabs automation pipeline.

## Requirements

- Node.js 24+
- GPM Login running on the configured local API port
- `service-account.json` with access to the configured Google Sheet

## Run

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. For a production build:

```powershell
npm run build
npm start
```

The production console is served at `http://127.0.0.1:4317`.

## Configuration

Copy `config.example.json` to `config.local.json` and adjust the local paths. Environment variables override the file:

- `MAIL_TEMP_SHEET_ID`
- `MAIL_TEMP_SHEET_NAME`
- `GOOGLE_SERVICE_ACCOUNT_PATH`
- `GPM_API_BASE`
- `MAIL_TEMP_DEFAULT_INTERVAL`
- `MAIL_TEMP_RUNTIME_DIR`

Job history, redacted logs and screenshots are stored under `.runtime/`. Account data remains in Google Sheet.

## Tests

```powershell
npm test
npm run build
```

The original CLI remains available:

```powershell
node signup-hotmail.js --row=25
npm run batch -- --limit=10
```

The UI and CLI share an exclusive automation lock, so they cannot control GPM at the same time.
