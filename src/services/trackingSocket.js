import { Server } from "socket.io";
import Booking from "../models/Booking.js";
import User from "../models/User.js";
import { verifyAccessToken } from "../utils/jwt.js";
import {
  canAccessBookingTracking,
  isBookingTrackable,
} from "./trackingAccessPolicy.js";
import { registerTrackingSocketServer } from "./trackingRealtime.js";
import { registerDispatchSocketServer } from "./dispatchRealtime.js";

const MAX_TRACKING_ROOMS_PER_SOCKET = 20;

function readCookie(cookieHeader, cookieName) {
  if (!cookieHeader) return null;

  for (const segment of cookieHeader.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;

    const name = segment.slice(0, separator).trim();
    if (name !== cookieName) continue;

    const value = segment.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}

function getAllowedOrigins(env) {
  return new Set(
    [
      env.CLIENT_URL,
      ...(process.env.CLIENT_URLS || "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
      ...(env.NODE_ENV !== "production"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : []),
    ].filter(Boolean)
  );
}

function acknowledge(callback, payload) {
  if (typeof callback === "function") callback(payload);
}

export function attachTrackingSocket(httpServer, env) {
  const allowedOrigins = getAllowedOrigins(env);

  const io = new Server(httpServer, {
    serveClient: true,
    cors: {
      origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) {
          return callback(null, true);
        }
        return callback(new Error("Socket origin is not allowed"));
      },
      credentials: true,
      methods: ["GET", "POST"],
    },
    allowRequest(request, callback) {
      const origin = request.headers.origin;
      callback(null, !origin || allowedOrigins.has(origin));
    },
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 32 * 1024,
  });

  io.use(async (socket, next) => {
    try {
      // The access token remains HTTP-only. The browser sends its cookie in
      // the Socket.IO handshake; no JWT is exposed to frontend JavaScript.
      const accessToken = readCookie(
        socket.handshake.headers.cookie,
        "accessToken"
      );

      if (!accessToken) {
        return next(new Error("Authentication required"));
      }

      const decoded = verifyAccessToken(accessToken);
      if (!decoded?.userId) {
        return next(new Error("Invalid access token"));
      }

      const user = await User.findById(decoded.userId)
        .select("role isActive")
        .lean();

      if (!user || !user.isActive) {
        return next(new Error("Account is not available"));
      }

      socket.data.user = {
        userId: String(decoded.userId),
        role: String(user.role ?? "").toLowerCase(),
      };

      // Socket connections outlive individual HTTP requests. End this socket
      // when its 15-minute access token expires; normal client reconnection
      // will use the current cookie after the app refreshes its session.
      if (Number.isFinite(decoded.exp)) {
        const expiresIn = Math.max(0, decoded.exp * 1000 - Date.now());
        socket.data.authExpiryTimer = setTimeout(() => {
          socket.disconnect(true);
        }, Math.min(expiresIn, 2_147_000_000));
      }

      return next();
    } catch {
      return next(new Error("Invalid or expired access token"));
    }
  });

  registerDispatchSocketServer(io);

  io.on("connection", (socket) => {
    const joinedRooms = new Set();

    // Driver dispatch events are sent only to this server-verified private room.
    // The room name is derived from the authenticated socket identity, never
    // from a client-supplied driver ID.
    if (socket.data.user.role === "driver") {
      void socket.join(`driver:${socket.data.user.userId}`);
    }

    socket.on("tracking:subscribe", async (payload = {}, callback) => {
      try {
        const bookingId = String(payload?.bookingId ?? "");
        if (!/^[a-f\d]{24}$/i.test(bookingId)) {
          return acknowledge(callback, {
            success: false,
            code: "INVALID_BOOKING_ID",
            message: "A valid booking ID is required.",
          });
        }

        const room = `booking:${bookingId}`;
        if (joinedRooms.has(room)) {
          return acknowledge(callback, { success: true, subscribed: true });
        }

        if (joinedRooms.size >= MAX_TRACKING_ROOMS_PER_SOCKET) {
          return acknowledge(callback, {
            success: false,
            code: "ROOM_LIMIT_REACHED",
            message: "Too many active tracking subscriptions.",
          });
        }

        const booking = await Booking.findById(bookingId)
          .select("_id customer driver status")
          .lean();

        if (!booking) {
          return acknowledge(callback, {
            success: false,
            code: "BOOKING_NOT_FOUND",
            message: "Booking not found.",
          });
        }

        if (!canAccessBookingTracking(socket.data.user, booking)) {
          return acknowledge(callback, {
            success: false,
            code: "TRACKING_FORBIDDEN",
            message: "You cannot access tracking for this booking.",
          });
        }

        if (!isBookingTrackable(booking)) {
          return acknowledge(callback, {
            success: true,
            subscribed: false,
            trackingActive: false,
            reason: booking.status === "delivered" || booking.status === "cancelled"
              ? "delivery_finished"
              : "waiting_for_driver",
          });
        }

        await socket.join(room);
        joinedRooms.add(room);
        return acknowledge(callback, {
          success: true,
          subscribed: true,
          trackingActive: true,
        });
      } catch (error) {
        console.error("Tracking socket subscribe error:", error.message);
        return acknowledge(callback, {
          success: false,
          code: "SUBSCRIPTION_FAILED",
          message: "Unable to subscribe to this booking's live location.",
        });
      }
    });

    socket.on("tracking:unsubscribe", async (payload = {}) => {
      const bookingId = String(payload?.bookingId ?? "");
      if (!/^[a-f\d]{24}$/i.test(bookingId)) return;

      const room = `booking:${bookingId}`;
      await socket.leave(room);
      joinedRooms.delete(room);
    });

    socket.on("disconnect", () => {
      if (socket.data.authExpiryTimer) {
        clearTimeout(socket.data.authExpiryTimer);
        socket.data.authExpiryTimer = null;
      }
      joinedRooms.clear();
    });
  });

  registerTrackingSocketServer(io);
  return io;
}
