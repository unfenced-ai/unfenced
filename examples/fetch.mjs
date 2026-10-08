import { Unfenced } from "../packages/sdk/dist/index.js";

if (!process.env.UNFENCED_TOKEN) throw new Error("Set UNFENCED_TOKEN before running this example.");
const client = new Unfenced({
  baseUrl: process.env.UNFENCED_URL ?? "https://unfenced.ai/api",
  apiKey: process.env.UNFENCED_TOKEN,
});
const result = await client.fetch(process.argv[2] ?? "https://example.com");
if (result.ok) console.log(result.content);
else {
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
