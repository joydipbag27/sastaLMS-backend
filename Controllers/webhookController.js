import Razorpay from "razorpay";
import Subscription from "../Models/subscriptionModel.js";
import User from "../Models/userModel.js";
import { PLANS } from "../config/plans.js";
import { redisClient } from "../config/redis.js";
import { razorpayInstance } from "../config/razorpay.js";
import { createNotification } from "../services/notificationService.js";
import { NOTIFICATION_TYPES } from "../config/notificationTypes.js";
import { syncUserPlan } from "../utils/syncUserPlan.js";

export const handleRazorpayWebhook = async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  const isSignatureVerified = Razorpay.validateWebhookSignature(
    JSON.stringify(req.body),
    signature,
    process.env.RAZORPAY_WEBHOOK_SECRET,
  );

  if (!isSignatureVerified) {
    console.error("Invalid Signature");
    return res.status(200).end();
  }

  console.log(req.body.event);

  const rzpSubscription = req.body.payload.subscription.entity;
  const subscriptionId = rzpSubscription.id;

  const subscription = await Subscription.findOne({
    razorpaySubscriptionId: subscriptionId,
  });

  if (!subscription) {
    return res.status(200).end();
  }

  const userId = subscription.userId;
  const planId = subscription.planId;

  const plan = PLANS.find((elem) => elem.planId === planId);

  if (!plan || !plan.isActive) {
    console.error("Invalid or inactive plan:", planId);
    return res.status(200).end();
  }

  if (req.body.event === "subscription.activated") {
    const otherActiveSub = await Subscription.findOne({
      userId,
      status: { $in: ["upgrading", "in_grace", "active"] },
      _id: { $ne: subscription._id },
    });

    if (otherActiveSub) {
      try {
        await razorpayInstance.subscriptions.cancel(
          otherActiveSub.razorpaySubscriptionId,
          false,
        );
      } catch (error) {
        console.error("Auto-cancel failed", error);
      }
    }

    try {
      await Subscription.findOneAndUpdate(
        {
          _id: subscription._id,
        },
        {
          status: "active",
          currentPeriodStart: new Date(rzpSubscription.current_start * 1000),
          currentPeriodEnd: new Date(rzpSubscription.current_end * 1000),
          deletionWarningSent: false,
          deletionScheduledAt: null,
          filesDeleted: false,
          filesDeletedAt: null,
        },
      );

      await User.findOneAndUpdate(
        { _id: userId },
        {
          bandwidthUsedBytes: 0,
          bandwidthCycleStart: new Date(rzpSubscription.current_start * 1000),
        },
      );

      await syncUserPlan(userId);

      await redisClient.json.del(`profile:${userId}`);

      await createNotification({
        userId,
        type: NOTIFICATION_TYPES.PLAN_UPGRADED,
        title: "Plan upgraded successfully",
        message: `Your plan has been upgraded to ${plan.name}.`,
        metadata: {
          planId: plan.planId,
          billingCycle: subscription.billingCycle,
        },
        group: false,
      });

      return res.status(200).end();
    } catch (error) {
      console.log(error);
      return res.status(200).end();
    }
  }

  //PAYING FOR THE ONGOING SUBSCRIPTION'S NEXT BILLING (SUCCESS)
  if (req.body.event === "subscription.charged") {
    try {
      await Subscription.findOneAndUpdate(
        {
          _id: subscription._id,
        },
        {
          status: "active",
          currentPeriodStart: new Date(rzpSubscription.current_start * 1000),
          currentPeriodEnd: new Date(rzpSubscription.current_end * 1000),
          gracePeriodEndsAt: null,
          deletionWarningSent: false,
          deletionScheduledAt: null,
          filesDeleted: false,
          filesDeletedAt: null,
        },
      );

      await User.findOneAndUpdate(
        { _id: userId },
        {
          bandwidthUsedBytes: 0,
          bandwidthCycleStart: new Date(rzpSubscription.current_start * 1000),
        },
      );

      await redisClient.json.del(`profile:${userId}`);

      await createNotification({
        userId,
        type: NOTIFICATION_TYPES.PAYMENT_SUCCESS,
        title: "Payment successful",
        message: `Your subscription payment was successful.`,
        metadata: {
          planId: subscription.planId,
          periodStart: new Date(rzpSubscription.current_start * 1000),
          periodEnd: new Date(rzpSubscription.current_end * 1000),
        },
        group: true,
      });

      return res.status(200).end();
    } catch (error) {
      console.log(error);
      return res.status(200).end();
    }
  }

  //PAYMENT FAILED
  if (req.body.event === "subscription.halted") {
    if (
      subscription.status === "in_grace" &&
      subscription.gracePeriodEndsAt &&
      subscription.gracePeriodEndsAt > new Date()
    ) {
      return res.status(200).end();
    }

    let gracePeriodDays = 5;

    if (subscription.status === "created") {
      gracePeriodDays = 1;
    }

    try {
      await Subscription.updateOne(
        { _id: subscription._id },
        {
          status: "in_grace",
          gracePeriodEndsAt: new Date(
            Date.now() + 1000 * 60 * 60 * 24 * gracePeriodDays,
          ),
        },
      );

      await redisClient.json.del(`profile:${userId}`);

      await createNotification({
        userId,
        type: NOTIFICATION_TYPES.PAYMENT_FAILED,
        title: "Payment failed",
        message:
          "We couldn't process your subscription payment. Please update your payment method.",
        metadata: {
          planId: subscription.planId,
          gracePeriodEndsAt: subscription.gracePeriodEndsAt,
        },
        group: true,
      });

      return res.status(200).end();
    } catch (error) {
      console.log(error);
      return res.status(200).end();
    }
  }

  //SUBSCRIPTION CANCELLED
  if (!subscription.scheduledDowngradeTo) {
    if (req.body.event === "subscription.cancelled") {
      const hasOtherActive = await Subscription.findOne({
        userId,
        status: "active",
        _id: { $ne: subscription._id },
      });

      try {
        await Subscription.updateOne(
          { _id: subscription._id },
          {
            status: "cancelled",
            cancelledAt: new Date(),
            cancelAtPeriodEnd: false,
          },
        );

        if (!hasOtherActive) {
          await User.findOneAndUpdate(
            { _id: userId },
            {
              bandwidthUsedBytes: 0,
              bandwidthCycleStart: new Date(),
            },

            await syncUserPlan(userId),
          );

          await createNotification({
            userId,
            type: NOTIFICATION_TYPES.SUBSCRIPTION_EXPIRED,
            title: "Subscription expired",
            message:
              "Your subscription has expired and your account has been moved to the free plan.",
            metadata: {},
            group: false,
          });
        }

        await redisClient.json.del(`profile:${userId}`);

        return res.status(200).end();
      } catch (error) {
        console.log(error);
        return res.status(200).end();
      }
    }
  }

  //DOWNGRADE
  if (subscription.scheduledDowngradeTo) {
    if (req.body.event === "subscription.cancelled") {
      const targetPlanId = subscription.scheduledDowngradeTo;
      try {
        await Subscription.updateOne(
          { _id: subscription._id },
          {
            status: "cancelled",
            cancelledAt: new Date(),
            cancelAtPeriodEnd: false,
          },
        );

        const scheduledDowngradePlan = PLANS.find(
          (elem) => elem.planId === targetPlanId,
        );

        if (!scheduledDowngradePlan) {
          console.error("scheduled downgrade plan not available");
          return res.status(200).end();
        }

        let downgradeSubscription;
        try {
          downgradeSubscription = await razorpayInstance.subscriptions.create({
            plan_id: targetPlanId,
            total_count:
              scheduledDowngradePlan.billingCycle === "monthly" ? 12 : 5,
            notes: {
              userId: userId,
            },
          });

          await Subscription.create({
            razorpaySubscriptionId: downgradeSubscription.id,
            userId: userId,
            planId: scheduledDowngradePlan.planId,
            billingCycle: scheduledDowngradePlan.billingCycle,
            planKey: scheduledDowngradePlan.key,
          });

          await Subscription.updateOne(
            { _id: subscription._id },
            {
              scheduledDowngradeTo: null,
            },
          );

          await createNotification({
            userId,
            type: NOTIFICATION_TYPES.PLAN_DOWNGRADED,
            title: "Plan downgraded",
            message: `Your plan has been downgraded to ${scheduledDowngradePlan.name}.`,
            metadata: {
              planId: scheduledDowngradePlan.planId,
              billingCycle: scheduledDowngradePlan.billingCycle,
            },
            group: false,
          });
        } catch (error) {
          console.error("Downgrade subscription failed to create", error);

          await User.findOneAndUpdate(
            { _id: userId },
            {
              bandwidthUsedBytes: 0,
              bandwidthCycleStart: new Date(),
            },
          );

          await syncUserPlan(userId);

          await Subscription.updateOne(
            { _id: subscription._id },
            {
              scheduledDowngradeTo: null,
            },
          );

          await createNotification({
            userId,
            type: NOTIFICATION_TYPES.SUBSCRIPTION_EXPIRED,
            title: "Subscription expired",
            message:
              "Your subscription has expired and your account has been moved to the free plan.",
            metadata: {},
            group: false,
          });
        }

        await redisClient.json.del(`profile:${userId}`);

        return res.status(200).end();
      } catch (error) {
        console.log(error);
        return res.status(200).end();
      }
    }
  }
};
