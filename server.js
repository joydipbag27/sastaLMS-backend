import app from "./app.js";
import { ConnectDB } from "./config/db.js";

await ConnectDB();

const port = process.env.PORT || 4000;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
