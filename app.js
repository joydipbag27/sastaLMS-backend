import "dotenv/config";
import express from "express";
import cors from "cors";
import userRoutes from "./Routes/userRoutes.js";
import authRoutes from "./Routes/authRoutes.js";
import rbacRoutes from "./Routes/rbacRoutes.js";
import courseRoutes from "./Routes/courseRoutes.js";
import sectionRoutes from "./Routes/sectionRoutes.js";
import lessonRoutes from "./Routes/lessonRoutes.js";
import mediaRoutes from "./Routes/mediaRoutes.js";
import paymentRoutes from "./Routes/paymentRoutes.js";
import cookieParser from "cookie-parser";
import { authenticate } from "./middlewares/authenticate.js";
import helmet from "helmet";

const app = express();

app.set("trust proxy", 1);
app.use(helmet());
app.use(cookieParser(process.env.SESSION_SECRET));
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

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
app.use("/users", authenticate, rbacRoutes);
app.use("/course", courseRoutes);
app.use("/section", sectionRoutes);
app.use("/lesson", lessonRoutes);
app.use("/media", mediaRoutes);
app.use("/payment", paymentRoutes);

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
