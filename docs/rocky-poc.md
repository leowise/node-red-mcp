# Rocky Node-RED POC

Checked 2026-09-24 on Raspberry Pi 3B+ `rocky` (`192.168.200.196`), running
Raspbian Buster (armv7l). The MCP server ran on Windows and connected to Rocky's
Node-RED admin API at `http://192.168.200.196:1880`. Rocky is a disposable lab
rig; this setup is for single-user testing.

Node-RED 3.1.15 runs from `/home/leowise/.local/share/node-red-3.1.15` with
Node.js 18.20.8 from `/home/leowise/.local/opt/node-v18.20.8-linux-armv7l`. The
dedicated user directory is `/home/leowise/.node-red-poc`. The enabled
`nodered-poc.service` starts the instance on port 1880. The pre-existing
`nodered.service` was disabled because its Node-RED 4.0.9 installation could not
start with the system's Node.js 16; its files were left intact. Node.js 20 was
tried side by side but was incompatible with Buster's C++ runtime libraries.

Useful service checks on Rocky:

```sh
sudo systemctl status nodered-poc.service
sudo journalctl -u nodered-poc.service -n 100 --no-pager
```

From the repository root on the MCP host, the built-server transport checks
passed in both read-only and write modes:

```text
node --import tsx tests/live-mcp-http-smoke.mts http://192.168.200.196:1880 3.1.15 --built --write --allow-remote
node --import tsx tests/live-mcp-stdio-smoke.mts http://192.168.200.196:1880 3.1.15 --built --write --allow-remote
```

The write checks created, read, validated, updated, enabled, disabled, and
deleted their temporary tabs. The separate agent POC then created a disabled
inject → Function → Debug tab, discovered and updated its Function, enabled the
tab briefly, and disabled it. Rocky's Node-RED journal showed the one-shot
message emitted from the updated Function with `revision: 2`. After a service
restart, API read-back confirmed the example tab remained disabled. Its label is
`Rocky MCP Agent POC 1e29174a`, and its flow ID is `e34ef3062524840c`. It has no
GPIO or MQTT nodes.

To run another isolated example with a new label:

```text
node --import tsx tests/live-agent-runtime-poc.mts http://192.168.200.196:1880 --allow-remote
```

The example script leaves its resulting tab disabled for inspection.
