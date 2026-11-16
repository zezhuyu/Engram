// Test children must never trigger a native macOS dashboard alert.
process.env.MDB_DASHBOARD_ALERT = 'false';
// A dashboard started by a test must never bring up the owner's real ChatGPT tunnel services.
process.env.ENGRAM_TUNNEL_AUTOSTART = 'off';
