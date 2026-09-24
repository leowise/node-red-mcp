# Live Node-RED compatibility checks

Checked on 2026-09-24 with this repository's MCP server and a real MCP SDK
client. The target range for this POC is Node-RED 1.x through 4.x. Each Docker
instance was isolated, had no mounted volumes, and exposed port 1880 only on the
host loopback interface.

| Node-RED | Test target                              | HTTP read/write | stdio read/write | Runtime info source |
| -------- | ---------------------------------------- | --------------- | ---------------- | ------------------- |
| 1.3.5    | `127.0.0.1:11813`                        | Pass            | Pass             | `/settings`         |
| 2.2.3    | `127.0.0.1:11822`                        | Pass            | Pass             | `/settings`         |
| 3.1.15   | `127.0.0.1:11831`                        | Pass            | Pass             | `/diagnostics`      |
| 4.1.15   | `127.0.0.1:11841`                        | Pass            | Pass             | `/diagnostics`      |
| 1.3.4    | Disposable Pluto (`192.168.200.29:1880`) | Read-only pass  | Read-only pass   | `/settings`         |

The read check initializes an SDK client, lists and calls tools, reads a flow
resource, and checks that read-only mode rejects a write call. HTTP also checks
Basic authentication and reuse of the authenticated MCP session ID. The write
check creates a uniquely named, initially disabled tab containing only a manual
inject wired to a debug node. It reads and validates the tab, updates its label,
enables and disables it, checks the delete dry run, deletes it, and confirms
that the original tab list is restored. The inject has no schedule or startup
trigger, and the test never triggers it. Cleanup searches only for its unique
label if a request fails after a write.

Run against a disposable local Node-RED instance from the repository root:

```text
node --import tsx tests/live-mcp-http-smoke.mts http://127.0.0.1:11822 2.2.3 --write
node --import tsx tests/live-mcp-stdio-smoke.mts http://127.0.0.1:11822 2.2.3 --write
```

Omit `--write` for a read-only check. Both scripts restrict their write mode to
a loopback Node-RED URL. Add `--built` to launch `dist/index.mjs` after a build
instead of the TypeScript source; both transports passed this check in read-only
mode. `tests/live-compat-smoke.mts` exercises the server's tool implementation
directly and is separate from these transport checks.

This is version spot-check coverage, not a guarantee for every minor release.
Node-RED 0.15.3 and 5.x are outside the current target. These checks do not
exercise GPIO, MQTT, module installation, OAuth, or long-lived SSE behavior.
