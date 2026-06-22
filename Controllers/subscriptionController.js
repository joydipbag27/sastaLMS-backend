import mongoose from "mongoose";
import { PLANS } from "../config/plans.js";
import { razorpayInstance } from "../config/razorpay.js";
import Subscription from "../Models/subscriptionModel.js";
import {
  CancelSchema,
  SelectPlanSchema,
  UpgradeAndDowngradePlanSchema,
} from "../validators/authSchema.js";
import User from "../Models/userModel.js";
import { redisClient } from "../config/redis.js";

//CREATE SUBSCRIPTION
export const createSubscription = async (req, res) => {
  const { success, data, error } = SelectPlanSchema.safeParse(req.body);

  if (!success) {
    return res.status(400).json({ error: error.issues[0].message });
  }

  const { planId, billingCycle } = data;

  const plan = PLANS.find(
    (elem) => elem.planId === planId && elem.billingCycle === billingCycle,
  );

  if (!plan) {
    return res.status(400).json({ error: "Invalid Plan ID" });
  }

  try {
    await Subscription.updateMany(
      {
        userId: req.user._id,
        status: "created",
        createdExpiresAt: { $lt: new Date() },
      },
      { status: "expired", expiredAt: new Date() },
    );

    const activeSub = await Subscription.findOne({
      userId: req.user._id,
      status: { $in: ["active", "in_grace"] },
    });

    if (activeSub) {
      return res
        .status(400)
        .json({ error: "You already have an active subscription" });
    }

    const existingSub = await Subscription.findOne({
      userId: req.user._id,
      status: "created",
      createdExpiresAt: { $gt: new Date() },
    });

    if (existingSub) {
      return res
        .status(200)
        .json({ subscriptionId: existingSub.razorpaySubscriptionId });
    }

    const newSubscription = await razorpayInstance.subscriptions.create({
      plan_id: plan.planId,
      total_count: billingCycle === "monthly" ? 12 : 5,
      notes: {
        userId: req.user._id,
      },
    });

    await Subscription.create({
      razorpaySubscriptionId: newSubscription.id,
      userId: req.user._id,
      planId: planId,
      billingCycle: billingCycle,
      planKey: plan.key,
      createdExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    return res.status(200).json({ subscriptionId: newSubscription.id });
  } catch (error) {
    console.error("Razorpay error:", error);
    return res.status(500).json({ error: "Failed to create subscription" });
  }
};

//CANCEL SUBSCRIPTION IMMEDIATELY AND AT THE END OF THE CYCLE
export const cancelSubscription = async (req, res) => {
  try {
    const { success, data, error } = CancelSchema.safeParse(req.body);

    if (!success) {
      return res.status(400).json({ error: error.issues[0].message });
    }

    const { immediate } = data;

    const subscriptionInfo = await Subscription.findOne({
      userId: req.user._id,
      status: { $in: ["active", "in_grace", "created"] },
    });

    if (!subscriptionInfo) {
      return res.status(404).json({ error: "No active subscription" });
    }

    if (immediate || subscriptionInfo.status === "created") {
      await razorpayInstance.subscriptions.cancel(
        subscriptionInfo.razorpaySubscriptionId,
        false,
      );

      return res
        .status(200)
        .json({ message: "Subscription cancelled successfully" });
    }

    await razorpayInstance.subscriptions.cancel(
      subscriptionInfo.razorpaySubscriptionId,
      true,
    );

    await Subscription.updateOne(
      { _id: subscriptionInfo._id },
      { cancelAtPeriodEnd: true },
    );

    return res
      .status(200)
      .json({ message: "Subscription will cancel at end of billing cycle" });
  } catch (error) {
    return res.status(500).json({ error: "Failed to cancel the subscription" });
  }
};

//FETCH CURRENT PLAN DETAILS
export const fetchPlanDetails = async (req, res) => {
  const subscriptionInfo = await Subscription.findOne({
    userId: req.user._id,
    status: { $in: ["active", "in_grace", "upgrading"] },
  });

  if (!subscriptionInfo) {
    return res.status(200).json({ status: "free" });
  }

  return res.status(200).json({
    planId: subscriptionInfo.planId,
    status: subscriptionInfo.status,
    billingCycle: subscriptionInfo.billingCycle,
    currentPeriodStart: subscriptionInfo.currentPeriodStart,
    currentPeriodEnd: subscriptionInfo.currentPeriodEnd,
    gracePeriodEndsAt: subscriptionInfo.gracePeriodEndsAt,
    cancelAtPeriodEnd: subscriptionInfo.cancelAtPeriodEnd,
  });
};

//UPGRADE PLAN
export const upgradePlan = async (req, res) => {
  const { success, data, error } = UpgradeAndDowngradePlanSchema.safeParse(
    req.body,
  );

  if (!success) {
    return res.status(400).json({ error: error.issues[0].message });
  }

  const { oldPlanId, newPlanId, oldBillingCycle, newBillingCycle } = data;

  const oldPlan = PLANS.find(
    (elem) =>
      elem.planId === oldPlanId && elem.billingCycle === oldBillingCycle,
  );

  const newPlan = PLANS.find(
    (elem) =>
      elem.planId === newPlanId && elem.billingCycle === newBillingCycle,
  );

  if (!oldPlan || !newPlan) {
    return res.status(400).json({ error: "Invalid Plan ID" });
  }

  if (!oldPlan.isActive || !newPlan.isActive) {
    return res.status(400).json({ error: "Invalid plans" });
  }

  if (oldPlanId === "spark_free") {
    return res
      .status(400)
      .json({ error: "You don't have any paid plans to upgrade" });
  }

  if (newPlan.tierLevel <= oldPlan.tierLevel) {
    return res
      .status(400)
      .json({ error: "Use downgrade endpoint for lower plans" });
  }

  const activeSub = await Subscription.findOne({
    userId: req.user._id,
    status: { $in: ["active", "in_grace"] },
  });

  if (!activeSub) {
    return res.status(400).json({
      error:
        "You don't have any current active or upgrading subscriptions to update",
    });
  }

  if (activeSub.planId !== oldPlanId) {
    return res.status(400).json({
      error: "Old plan does not match current subscription",
    });
  }

  if (activeSub.status === "upgrading" && activeSub.upgradingTo) {
    return res.status(200).json({ subscriptionId: activeSub.upgradingTo });
  }

  const session = await mongoose.startSession();

  try {
    const newSubscription = await razorpayInstance.subscriptions.create({
      plan_id: newPlanId,
      total_count: oldBillingCycle === "monthly" ? 12 : 5,
      notes: {
        userId: req.user._id,
      },
    });

    session.startTransaction();

    const updateResult = await Subscription.updateOne(
      {
        _id: activeSub._id,
        planId: oldPlanId,
        status: { $in: ["active", "in_grace"] },
      },
      { status: "upgrading", upgradingTo: newSubscription.id },
      { session },
    );

    if (updateResult.modifiedCount !== 1) {
      throw new Error("Failed to mark subscription as upgrading");
    }

    const sub = new Subscription({
      razorpaySubscriptionId: newSubscription.id,
      userId: req.user._id,
      planId: newPlanId,
      billingCycle: newBillingCycle,
      planKey: newPlan.key,
      createdExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    await sub.save({ session });

    await session.commitTransaction();
    session.endSession();

    try {
      await razorpayInstance.subscriptions.cancel(
        activeSub.razorpaySubscriptionId,
        false,
      );
    } catch (error) {
      console.error("Cancel old subscription failed", error);
    }

    return res.status(200).json({ subscriptionId: newSubscription.id });
  } catch (error) {
    if (session) {
      await Subscription.updateOne(
        { _id: activeSub._id },
        { status: activeSub.status },
        { session },
      );

      await session.abortTransaction();
      session.endSession();
    }

    console.log(error);
    return res.status(500).json({ error: "Failed to upgrade new plan" });
  }
};

//DOWNGRADE PLAN
export const downgradePlan = async (req, res) => {
  const { success, data, error } = UpgradeAndDowngradePlanSchema.safeParse(
    req.body,
  );

  if (!success) {
    return res.status(400).json({ error: error.issues[0].message });
  }

  const { oldPlanId, newPlanId, oldBillingCycle, newBillingCycle } = data;

  const oldPlan = PLANS.find(
    (elem) =>
      elem.planId === oldPlanId && elem.billingCycle === oldBillingCycle,
  );

  const newPlan = PLANS.find(
    (elem) =>
      elem.planId === newPlanId && elem.billingCycle === newBillingCycle,
  );

  if (!oldPlan || !newPlan) {
    return res.status(400).json({ error: "Invalid Plan ID" });
  }

  if (!oldPlan.isActive || !newPlan.isActive) {
    return res.status(400).json({ error: "Invalid plans" });
  }

  if (oldPlanId === "spark_free") {
    return res
      .status(400)
      .json({ error: "You don't have any paid plans to downgrade" });
  }

  if (newPlan.tierLevel >= oldPlan.tierLevel) {
    return res
      .status(400)
      .json({ error: "Use upgrade endpoint for higher plans" });
  }

  const activeSub = await Subscription.findOne({
    userId: req.user._id,
    status: { $in: ["active", "in_grace"] },
  });

  if (!activeSub) {
    return res.status(400).json({
      error:
        "You don't have any current active or upgrading subscriptions to update",
    });
  }

  if (activeSub.planId !== oldPlanId) {
    return res.status(400).json({
      error: "Old plan does not match current subscription",
    });
  }

  if (activeSub.scheduledDowngradeTo === newPlanId) {
    return res.status(400).json({
      error: "Downgrade already scheduled",
    });
  }

  try {
    if (!activeSub.cancelAtPeriodEnd) {
      await razorpayInstance.subscriptions.cancel(
        activeSub.razorpaySubscriptionId,
        true,
      );
      await Subscription.updateOne(
        { _id: activeSub._id },
        { cancelAtPeriodEnd: true, scheduledDowngradeTo: newPlanId },
      );
    } else {
      await Subscription.updateOne(
        { _id: activeSub._id },
        { scheduledDowngradeTo: newPlanId },
      );
    }

    return res
      .status(200)
      .json({ message: "Plan downgrade successfully scheduled" });
  } catch (error) {
    return res.status(500).json({ error: "Failed to downgrade" });
  }
};

export const getInvoice = async (req, res) => {
  const subscription = await Subscription.findOne({
    userId: req.user._id,
    status: { $in: ["active", "in_grace"] },
  });

  if (!subscription) {
    return res.status(404).json({ error: "No active subscription" });
  }

  try {
    const invoicesMeta = await razorpayInstance.invoices.all({
      subscription_id: subscription.razorpaySubscriptionId,
    });

    const formatted = invoicesMeta.items.map((inv) => ({
      invoiceId: inv.id,
      amount: inv.amount / 100,
      currency: inv.currency,
      status: inv.status,
      invoiceUrl: inv.short_url,
      issuedAt: new Date(inv.date * 1000),
    }));

    return res.status(200).json(formatted);
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch invoices" });
  }
};

export const dummyActivateSubscription = async (req, res) => {
  const { success, data, error } = SelectPlanSchema.safeParse(req.body);

  if (!success) {
    return res.status(400).json({ error: error.issues[0].message });
  }

  const { planId, billingCycle } = data;

  const plan = PLANS.find(
    (elem) => elem.planId === planId && elem.billingCycle === billingCycle,
  );

  if (!plan) {
    return res.status(400).json({ error: "Invalid Plan ID" });
  }

  try {
    const now = new Date();
    const end = new Date();

    if (billingCycle === "yearly") {
      end.setFullYear(end.getFullYear() + 1);
    } else {
      end.setMonth(end.getMonth() + 1);
    }

    const subscriptionInfo = await Subscription.findOneAndUpdate(
      {
        userId: req.user._id,
        status: { $in: ["active", "in_grace", "created"] },
      },
      { status: "cancelled", cancelledAt: now },
    );

    await Subscription.create({
      razorpaySubscriptionId: plan.key,
      userId: req.user._id,
      status: "active",
      planId: planId,
      billingCycle: billingCycle,
      planKey: plan.key,
      currentPeriodStart: now,
      currentPeriodEnd: end,
    });

    await User.findOneAndUpdate(
      { _id: req.user._id },
      { $set: { planId: planId } },
    );

    await redisClient.json.del(`profile:${req.user._id}`);

    return res
      .status(200)
      .json({ message: "demo subscription activated", success: true });
  } catch (error) {
    console.error("Razorpay error:", error);
    return res.status(500).json({ error: "Failed to create subscription" });
  }
};

export const dummyCancelSubscription = async (req, res) => {
  try {
    const subscriptionInfo = await Subscription.findOne({
      userId: req.user._id,
      status: { $in: ["active", "in_grace", "created"] },
    });

    if (!subscriptionInfo) {
      return res.status(404).json({ error: "No active subscription" });
    }

    await Subscription.updateOne(
      { _id: subscriptionInfo._id },
      { status: "cancelled", cancelledAt: new Date() },
    );

    await User.findOneAndUpdate(
      { _id: req.user._id },
      { $set: { planId: "spark_free" } },
    );

    await redisClient.json.del(`profile:${req.user._id}`);

    return res
      .status(200)
      .json({ message: "Subscription cancelled successfully" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to cancel the subscription" });
  }
};
