// Starts the seed + fleet checker once the Node server boots. The import sits
// inside the NEXT_RUNTIME check so that the edge bundle drops it entirely.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { boot } = await import("./checker-boot");
    await boot();
  }
}
