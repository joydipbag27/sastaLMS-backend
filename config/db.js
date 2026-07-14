import "dotenv/config";
import mongoose from "mongoose";

export async function ConnectDB() {
  if (mongoose.connection.readyState >= 1) {
    console.log("Database already connected (warm reuse)");
    return;
  }
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Database Connected");
  } catch (error) {
    console.error(error);
    console.log("Could not connect to the Database");
  }
}

process.on("SIGINT", async () => {
  await mongoose.disconnect();
  console.log("Database Disconnected");
  process.exit(0);
});
