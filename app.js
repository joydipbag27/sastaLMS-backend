import "dotenv/config";
import express from "express";
import cors from "cors";
import userRoutes from "./Routes/userRoutes.js";
import authRoutes from "./Routes/authRoutes.js";
import rbacRoutes from "./Routes/rbacRoutes.js";
import notificationRoutes from "./Routes/notificationRoutes.js";
import subscriptionRoutes from "./Routes/subscriptionRoutes.js";
import webhookRoutes from "./Routes/webhookRoutes.js";
import cookieParser from "cookie-parser";
import { checkAuth, checkIfBlocked } from "./middlewares/authMiddleware.js";
import helmet from "helmet";

const app = express();

app.set("trust proxy", 1);
app.use(helmet());
app.use(cookieParser(process.env.SESSION_SECRET));
app.use(express.json());

const allowedOrigins = process.env.CLIENT_URL
  ? process.env.CLIENT_URL.split(",")
  : [];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
);

app.use("/user", userRoutes);
app.use("/auth", authRoutes);
app.use("/users", checkAuth, checkIfBlocked, rbacRoutes);
app.use("/notification", checkAuth, checkIfBlocked, notificationRoutes);
app.use("/subscription", checkAuth, checkIfBlocked, subscriptionRoutes);
app.use("/webhook", webhookRoutes);

app.use((error, req, res, next) => {
  // ---- Mongoose validation errors ----
  if (error.name === "ValidationError") {
    const message = Object.values(error.errors)[0].message;
    return res.status(400).json({ error: message });
  }

  // ---- Mongo duplicate key errors ----
  if (error.code === 11000) {
    const field = Object.keys(error.keyValue)[0];
    return res.status(409).json({
      error: `${field} already exists`,
    });
  }

  // ---- Custom operational errors ----
  if (error.isOperational) {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }

  // ---- Unknown / programming errors ----
  console.error("INTERNAL ERROR:", error);

  return res.status(500).json({
    error: "Something went wrong",
  });
});

export default app;
