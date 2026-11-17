# hello-node (Python)

The smallest useful Landflow plugin in Python: `greet` (a credential, two outputs) and `newRequest` (a poll trigger).
Walk-through: [docs/platform/sdk/python.md](../../../../docs/platform/sdk/python.md).

| File | What |
|---|---|
| `hello_node/__init__.py` | the credential type, the two nodes, `build_plugin()` |
| `main.py` | `serve(build_plugin(), http_port=7192, grpc_port=7292)` |
| `tests/test_hello.py` | `unittest`: build the request the host sends, call `plugin.execute`, read the response |
| `setup.sh` | creates `.venv` (gitignored) and installs `sdks/python` from this checkout, editable, with the gRPC and MCP extras |

```bash
cd examples/sdk/python/hello-node
./setup.sh
.venv/bin/python -m unittest discover -s tests
LANDFLOW_REGISTRY_URL=off .venv/bin/python main.py      # then, in another shell:
curl -s localhost:7192/.well-known/landflow
curl -s localhost:7192/landflow/v1/manifest
```

To show up in a dev host, leave out `LANDFLOW_REGISTRY_URL=off` (it announces to `http://127.0.0.1:3000`). Without
`setup.sh`, `main.py` and the tests fall back to `sdks/python` in this checkout (HTTP only, no gRPC).
