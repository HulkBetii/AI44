import subprocess
import re
import json

ps_cmd = 'Get-CimInstance Win32_Process -Filter "name like \'%chrome%\'" | Select-Object ProcessId, CommandLine | ConvertTo-Json'
p = subprocess.run(['powershell', '-NoProfile', '-Command', ps_cmd], capture_output=True, text=True, encoding='utf-8')

if p.returncode == 0 and p.stdout:
    try:
        data = json.loads(p.stdout)
        if isinstance(data, dict):
            data = [data]
        for item in data:
            cmd = item.get('CommandLine') or ''
            if '--remote-debugging-port' in cmd:
                m = re.search(r'--remote-debugging-port=(\d+)', cmd)
                if m:
                    print(f"DEBUG_PORT: {m.group(1)} (PID: {item.get('ProcessId')})")
    except Exception as e:
        print("Parse error:", e)
else:
    print("Error:", p.stderr)
