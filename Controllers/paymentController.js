import crypto from "crypto";
import mongoose from "mongoose";
import Course from "../Models/courseModel.js";
import Enrollment from "../Models/enrollmentModel.js";
import Payment from "../Models/paymentModel.js";
import { razorpayInstance } from "../config/razorpay.js";
import { createOrderSchema } from "../validators/paymentSchema.js";
import { successResponse, errorResponse } from "../utils/response.js";

// CREATE PAYMENT ORDER
export const createPaymentOrder = async (req, res) => {
  try {
    const { success, data, error } = createOrderSchema.safeParse(req.body);
    if (!success) {
      return errorResponse(res, 400, error.issues[0].message);
    }

    const { courseId } = data;
    const userId = req.user._id;

    // Fetch Course
    const course = await Course.findById(courseId);
    if (!course) {
      return errorResponse(res, 404, "Course not found");
    }

    // Verify Course is Published
    if (course.status !== "Published") {
      return errorResponse(res, 400, "Cannot purchase a course that is not published");
    }

    // Verify Course has a valid price greater than 0
    if (!course.price || course.price <= 0) {
      return errorResponse(res, 400, "Course must have a valid price greater than 0 to be purchased");
    }

    // Verify user is not course creator
    if (course.creator.toString() === userId.toString()) {
      return errorResponse(res, 400, "Course creators cannot purchase their own courses");
    }

    // Verify user is not already enrolled
    const existingEnrollment = await Enrollment.findOne({ user: userId, course: courseId });
    if (existingEnrollment) {
      return errorResponse(res, 400, "You are already enrolled in this course");
    }

    // Convert price to smallest currency unit (paise for INR)
    const amountInPaise = Math.round(course.price * 100);

    // Pre-generate Payment ID to use as order receipt
    const paymentId = new mongoose.Types.ObjectId();

    // Create Razorpay Order
    let razorpayOrder;
    try {
      razorpayOrder = await razorpayInstance.orders.create({
        amount: amountInPaise,
        currency: "INR",
        receipt: paymentId.toString(),
      });
    } catch (razorpayErr) {
      console.error("[createPaymentOrder] Razorpay API call failed:", razorpayErr);
      return errorResponse(res, 502, "Payment gateway communication failed");
    }

    // ONLY after success, create the Payment document
    await Payment.create({
      _id: paymentId,
      user: userId,
      course: courseId,
      amount: course.price,
      razorpayOrderId: razorpayOrder.id,
      status: "Created",
    });

    return successResponse(res, 201, "Payment order created successfully", {
      key: process.env.RAZORPAY_KEY_ID,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      orderId: razorpayOrder.id,
    });

  } catch (err) {
    console.error("[createPaymentOrder] Unexpected error:", err);
    return errorResponse(res, 500, "Failed to create payment order");
  }
};

// HANDLE RAZORPAY WEBHOOK
export const handleRazorpayWebhook = async (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"];
    if (!signature) {
      return errorResponse(res, 400, "Webhook signature missing");
    }



    const rawBody = req.rawBody;
    if (!rawBody) {
      console.error("[handleRazorpayWebhook] Raw body not captured.");
      return errorResponse(res, 500, "Internal configuration error");
    }

    // Verify webhook signature
    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET || "")
      .update(rawBody)
      .digest("hex");



    const generatedHash = crypto.createHash("sha256").update(generatedSignature).digest();
    const receivedHash = crypto.createHash("sha256").update(signature).digest();

    const isSignatureValid = crypto.timingSafeEqual(generatedHash, receivedHash);

    if (!isSignatureValid) {
      return errorResponse(res, 400, "Invalid webhook signature");
    }

    const payload = req.body;
    const event = payload.event;
    
    if (event !== "payment.captured") {
      return successResponse(res, 200, "Event ignored", { event });
    }

    const orderEntity = payload.payload?.order?.entity;
    const paymentEntity = payload.payload?.payment?.entity;

    if (!paymentEntity) {
      return errorResponse(res, 400, "Invalid webhook payload structure");
    }

    const razorpayOrderId = paymentEntity.order_id || orderEntity?.id;
    const razorpayPaymentId = paymentEntity.id;

    if (!razorpayOrderId || !razorpayPaymentId) {
      return errorResponse(res, 400, "Invalid webhook payment details");
    }

    // Find the corresponding Payment document by razorpayOrderId
    const payment = await Payment.findOne({ razorpayOrderId });
    if (!payment) {
      return errorResponse(res, 404, "Payment record not found for this order");
    }

    // Idempotency: Ignore duplicate webhook deliveries if already Paid
    if (payment.status === "Paid") {
      await Enrollment.findOneAndUpdate(
        { user: payment.user, course: payment.course },
        { $setOnInsert: { status: "Active", enrolledAt: new Date() } },
        { upsert: true, new: true }
      );
      return successResponse(res, 200, "Webhook processed idempotently (already paid)");
    }

    // Mark Payment as Paid
    payment.status = "Paid";
    payment.razorpayPaymentId = razorpayPaymentId;
    await payment.save();

    // Create Enrollment idempotently
    await Enrollment.findOneAndUpdate(
      { user: payment.user, course: payment.course },
      { $setOnInsert: { status: "Active", enrolledAt: new Date() } },
      { upsert: true, new: true }
    );

    return successResponse(res, 200, "Webhook processed successfully, course enrolled");

  } catch (err) {
    console.error("[handleRazorpayWebhook] Unexpected error:", err);
    return errorResponse(res, 500, "Webhook processing failed");
  }
};
