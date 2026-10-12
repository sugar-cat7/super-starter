# Execution acceptance

Source SHA: 653abf13ae3a54b2434c422ab8dc6800822387c3
Result: **blocked**

| Preset | OS | Result | Evidence |
| --- | --- | --- | --- |
| web | linux | passed | generated-evidence-web-Linux/artifacts/gate-full-all-linux.json |
| api | linux | passed | generated-evidence-api-Linux/artifacts/gate-full-all-linux.json |
| desktop | linux | passed | generated-evidence-desktop-Linux/artifacts/gate-full-all-linux.json |
| desktop | darwin | passed | generated-evidence-desktop-macOS/artifacts/gate-full-all-darwin.json |
| desktop | win32 | passed | generated-evidence-desktop-Windows/artifacts/gate-full-all-win32.json |
| fullstack | linux | passed | generated-evidence-fullstack-Linux/artifacts/gate-full-all-linux.json |
| fullstack-desktop | linux | passed | generated-evidence-fullstack-desktop-Linux/artifacts/gate-full-all-linux.json |
| web-bindings | linux | passed | generated-evidence-web-bindings-Linux/artifacts/gate-full-all-linux.json |
| api-bindings | linux | passed | generated-evidence-api-bindings-Linux/artifacts/gate-full-all-linux.json |
| web-d1 | linux | passed | generated-evidence-web-d1-Linux/artifacts/gate-full-all-linux.json |
| web-kv | linux | passed | generated-evidence-web-kv-Linux/artifacts/gate-full-all-linux.json |
| web-r2 | linux | passed | generated-evidence-web-r2-Linux/artifacts/gate-full-all-linux.json |
| api-d1 | linux | passed | generated-evidence-api-d1-Linux/artifacts/gate-full-all-linux.json |
| api-kv | linux | passed | generated-evidence-api-kv-Linux/artifacts/gate-full-all-linux.json |
| api-r2 | linux | passed | generated-evidence-api-r2-Linux/artifacts/gate-full-all-linux.json |

- faults-web-linux: passed; generated-evidence-web-Linux/artifacts/fault-rehearsal-linux/faults.json
- faults-api-bindings-linux: passed; generated-evidence-api-bindings-Linux/artifacts/fault-rehearsal-linux/faults.json
- faults-desktop-linux: passed; generated-evidence-desktop-Linux/artifacts/fault-rehearsal-linux/faults.json
- faults-desktop-darwin: passed; generated-evidence-desktop-macOS/artifacts/fault-rehearsal-darwin/faults.json
- faults-desktop-win32: passed; generated-evidence-desktop-Windows/artifacts/fault-rehearsal-win32/faults.json
- worker-win32: passed; actual-worker-evidence-Windows/artifacts/gate-ci-worker-win32.json
- hooks-linux: passed; generated-evidence-web-Linux/artifacts/hooks.json
- hooks-win32: passed; generated-evidence-desktop-Windows/artifacts/hooks.json
- lifecycle: passed; generated-evidence-web-Linux/artifacts/lifecycle.json
- sanitization: passed; source-evidence/artifacts/sanitization.json
- real-signals-mcp: passed; observability-evidence/verified.json
- agent-web-api: blocked; Required actual execution report missing, incomplete, failed or stale
- agent-desktop: blocked; Required actual execution report missing, incomplete, failed or stale
- agent-package-add: blocked; Required actual execution report missing, incomplete, failed or stale
