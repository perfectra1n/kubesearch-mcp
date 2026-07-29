#!/bin/sh
# Container healthcheck. Only the http transport listens on a port; in stdio
# mode there is nothing to probe, so report healthy instead of failing forever.
# Transport aliases mirror parseTransport() in src/config.ts.
case "${MCP_TRANSPORT:-stdio}" in
  http | streamable-http | streamablehttp) ;;
  *) exit 0 ;;
esac

# Liveness only — /readyz would fail the container during the initial download.
exec node -e "
const port = process.env.MCP_HTTP_PORT || process.env.PORT || 3000;
fetch('http://127.0.0.1:' + port + '/healthz')
  .then((r) => process.exit(r.ok ? 0 : 1))
  .catch(() => process.exit(1));
"
