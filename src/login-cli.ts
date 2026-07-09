import { runLogin } from "./login.js";

/**
 * Standalone login runner: `npm run login`.
 * Useful for the first-time setup or when the browser flow is easier to run
 * outside of an MCP tool call.
 */
async function main(): Promise<void> {
  const result = await runLogin({ log: (m) => console.log(m) });
  console.log(
    `\nDone. cookieCaptured=${result.cookieCaptured}, endpointsFound=${result.endpointsFound}`,
  );
  for (const ep of result.topEndpoints) {
    console.log(`  ${ep.method} ${ep.url}  keys=[${(ep.sampleResponseKeys ?? []).join(", ")}]`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
