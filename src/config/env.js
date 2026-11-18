
import dotenv from "dotenv";
import { parseTrustProxy, validateRuntimeSecurity } from "../utils/runtimeSecurity.js";

dotenv.config();

const requiredEnvVariables = [
  "MONGODB_URI",
  "JWT_ACCESS_SECRET",
  "JWT_REFRESH_SECRET",
  "CLIENT_URL",
  "MAPBOX_ACCESS_TOKEN",
];

for (const variable of requiredEnvVariables) {
  if (!process.env[variable]) {
    throw new Error(
      `Missing required environment variable: ${variable}`
    );
  }
}

const nodeEnv = process.env.NODE_ENV || "development";
const runtimeSecurityErrors = validateRuntimeSecurity({
  nodeEnv,
  accessSecret: process.env.JWT_ACCESS_SECRET,
  refreshSecret: process.env.JWT_REFRESH_SECRET,
  clientUrl: process.env.CLIENT_URL,
});

if (runtimeSecurityErrors.length > 0) {
  throw new Error(
    `Invalid production security configuration: ${runtimeSecurityErrors.join(" ")}`
  );
}

const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);

export const env = {
  PORT: Number(process.env.PORT) || 5000,
  MONGODB_URI: process.env.MONGODB_URI,
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  CLIENT_URL: process.env.CLIENT_URL,
  MAPBOX_ACCESS_TOKEN: process.env.MAPBOX_ACCESS_TOKEN,
  NODE_ENV: nodeEnv,
  TRUST_PROXY: trustProxy,
};
