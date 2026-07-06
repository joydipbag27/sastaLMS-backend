import express from "express";
import { createPaymentOrder, handleRazorpayWebhook } from "../Controllers/paymentController.js";
import { authenticate } from "../middlewares/authenticate.js";
import { customRateLimit } from "../middlewares/rateLimit.js";

const router = express.Router();

router.post("/order", customRateLimit(5, 10), authenticate, createPaymentOrder);
router.post("/webhook", customRateLimit(5, 30), handleRazorpayWebhook);

export default router;
