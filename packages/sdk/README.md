# @unfenced-ai/sdk

A typed, zero-runtime-dependency client for [Unfenced](https://unfenced.ai).
Requires Node.js **22.12+** and an authorized Unfenced account. Unfenced is in private
preview: installing the SDK does not grant hosted access. Get an API key from the
dashboard's Connect panel and set it locally as `UNFENCED_TOKEN`.

```sh
npm install @unfenced-ai/sdk
```

```js
import { Unfenced } from "@unfenced-ai/sdk";

const client = new Unfenced({
  baseUrl: "https://unfenced.ai/api",
  apiKey: process.env.UNFENCED_TOKEN,
});
const result = await client.fetch("https://example.com");
if (!result.ok) throw new Error(JSON.stringify(result));
console.log(result.content);
```

Live sessions support observation, actions, extraction, and closing:

```js
const session = await client.open("https://example.com");
try {
  console.log(await session.observe());
  console.log(await session.extract("markdown"));
} finally {
  await session.close();
}
```

Use fresh control references from observations when acting. The service enforces site
permissions and credential handling. Do not place your API key in frontend code.

The package exports `Unfenced`, `UnfencedError`, `Session`, and the public API types.
See [runnable examples](https://github.com/unfenced-ai/unfenced/tree/main/examples)
and [Security](https://github.com/unfenced-ai/unfenced/blob/main/SECURITY.md).

[Source and issues](https://github.com/unfenced-ai/unfenced) ·
[MIT license](https://github.com/unfenced-ai/unfenced/blob/main/LICENSE)
