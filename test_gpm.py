import urllib.request
import json

base = "http://127.0.0.1:19995"
profile_id = "a9f07ebf-c5fa-4f14-b27d-2bd88206d0b4"

endpoints = [
    f"/api/v3/profiles/stop/{profile_id}",
    f"/api/v3/profiles/close/{profile_id}",
    f"/v2/stop?profile_id={profile_id}",
    f"/v2/start?profile_id={profile_id}",
    f"/api/v3/profiles/start/{profile_id}",
]

for ep in endpoints:
    url = base + ep
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = resp.read().decode('utf-8')
            print(f"{ep} -> {data}")
    except Exception as e:
        print(f"{ep} -> Exception: {e}")
