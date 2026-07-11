import { createApp } from "./app.js";

const port = Number(process.env.PORT || 8799);
const app = await createApp();

app.listen(port, "0.0.0.0", () => {
  console.log(`[LICENSE402] API listening on http://127.0.0.1:${port}`);
});
