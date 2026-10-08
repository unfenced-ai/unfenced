import { Unfenced } from "../packages/sdk/dist/index.js";

if (!process.env.UNFENCED_TOKEN) throw new Error("Set UNFENCED_TOKEN before running this example.");
const client = new Unfenced({
  baseUrl: process.env.UNFENCED_URL ?? "https://unfenced.ai/api",
  apiKey: process.env.UNFENCED_TOKEN,
});
const session = await client.open(process.argv[2] ?? "https://example.com");
try {
  console.log(await session.observe());
  console.log(await session.extract("markdown"));
} finally {
  await session.close();
}
