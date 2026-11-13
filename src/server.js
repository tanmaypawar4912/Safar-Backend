
import { env } from "./config/env.js";
import connectDB from "./config/db.js";
import app from "./app.js";
import { startDispatchWorker } from "./services/dispatchService.js";

const startServer = async () => {
  try {
    await connectDB();

    startDispatchWorker();

    app.listen(env.PORT, "0.0.0.0", () => {
      console.log(`LogiGo API listening on port ${env.PORT}`);
      console.log("LAN access is enabled; use this computer's IPv4 address.");
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
};

startServer();
