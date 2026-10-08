# Security

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/unfenced-ai/unfenced/security/advisories/new).
Do not put credentials, session recordings, private page content, or exploit details
in a public issue. Include the affected client version, reproduction steps against
a test account, and the expected boundary.

## Client and service boundary

The npm connector and SDK forward authenticated requests to the configured API.
Use HTTPS for remote services and only configure endpoints you trust. Anyone who
controls the endpoint receives the API token and the requests you send.

Browser execution, permission enforcement, stored credentials, and session storage
live on the service. The service fills persistent credentials by name without returning
their values through MCP. The SDK provides a human-facing credential storage method;
it is deliberately not exposed as an MCP tool.

Actions are constrained by account permissions. Submission requires explicit protocol
confirmation; an agent must still obtain appropriate human authorization. A single-use
verification code can pass through the designated OTP action, unlike a persistent
password or TOTP seed. Prefer human handoff for sensitive authentication steps.

Keep tokens in environment variables or your client's protected configuration. Never
include them in URLs, screenshots, prompts, example files, or issue reports. Revoke a
token from the dashboard if it is exposed.

## Supported code

Security fixes target the current client source and the latest client release.
Client tests verify requests, tool contracts, limits, and local transport behavior.
They do not establish the security or availability of any particular hosted deployment.
