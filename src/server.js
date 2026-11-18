import { createServer } from "node:http";

import { env } from "./config/env.js";
import connectDB from "./config/db.js";
import app from "./app.js";
import { startDispatchWorker } from "./services/dispatchService.js";
import { attachTrackingSocket } from "./services/trackingSocket.js";

const startServer = async () => {
  try {
    // Trust only the explicitly configured reverse-proxy hop count.
    app.set("trust proxy", env.TRUST_PROXY);
    await connectDB();

    // Start the periodic auto-dispatch sweep only after MongoDB is connected.
    startDispatchWorker();

    // Share one HTTP server between Express and Socket.IO.
    const httpServer = createServer(app);
    attachTrackingSocket(httpServer, env);

    httpServer.listen(env.PORT, "0.0.0.0", () => {
      console.log(`LogiGo API listening on port ${env.PORT}`);
      console.log("LAN access enabled. Use this computer's IPv4 address from your phone.");
      console.log("LogiGo real-time tracking Socket.IO server is ready.");
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
};

startServer();
