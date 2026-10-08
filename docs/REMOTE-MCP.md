# Connect without installing a package

Unfenced's hosted MCP connection does not require Node.js or an npm install.
You still need an admitted Unfenced account: the hosted service is in private preview.

## Connect

1. Open your MCP client's connection settings and add a remote server.
2. Select Streamable HTTP if the client asks for a transport.
3. Enter `https://unfenced.ai/api/mcp`.
4. Complete the OAuth sign-in when offered. Otherwise, if your client supports
   custom headers, set `Authorization: Bearer YOUR_UNFENCED_API_KEY` using the key
   from your [dashboard](https://app.unfenced.ai).
5. Try: "Read https://example.com with Unfenced and summarize the page."

Client settings vary; the dashboard's **Connect** instructions cover supported
clients. Store keys in your client's secure configuration, outside prompts,
screenshots, URLs, and source control.

## Connection troubleshooting

| Symptom                                                  | What to check                                                                                                                |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A browser visit or unauthenticated request returns `401` | The endpoint requires authentication. Use an MCP client and complete sign-in or configure the Bearer header.                 |
| The client cannot discover sign-in                       | Check that it supports remote MCP with OAuth. The service advertises OAuth through the endpoint's `WWW-Authenticate` header. |
| Sign-in succeeds but access is denied                    | Confirm that the account has been admitted to the private preview.                                                           |
| The client only supports a local command                 | Use the [stdio connector](../README.md#local-stdio-connector).                                                               |
| A site needs interactive sign-in                         | Follow the tool's instructions to take over the browser session.                                                             |

Connecting does not grant blanket permission to act on websites. Authorize the
sites you need and review consequential submissions. See [Security](../SECURITY.md).
