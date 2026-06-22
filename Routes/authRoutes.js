import express from "express";
import { loginWithGoogle, sendOtp } from "../Controllers/authController.js";
import { customRateLimit } from "../middlewares/rateLimit.js";

const router = express.Router();

router.post("/send-otp", customRateLimit(1, 2), sendOtp);

router.post("/google", customRateLimit(1, 5), loginWithGoogle);

export default router;
