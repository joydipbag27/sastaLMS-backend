import express from "express";
import {
  cancelSubscription,
  createSubscription,
  downgradePlan,
  dummyActivateSubscription,
  dummyCancelSubscription,
  fetchPlanDetails,
  getInvoice,
  upgradePlan,
} from "../Controllers/subscriptionController.js";

const router = express.Router();

router.post("/create", createSubscription);

router.post("/cancel", cancelSubscription);

router.get("/me", fetchPlanDetails);

router.post("/upgrade", upgradePlan);

router.post("/downgrade", downgradePlan);

router.get("/active-invoice", getInvoice);

//DUMMY ROUTES

router.post("/dummy/activate", dummyActivateSubscription);
router.post("/dummy/cancel", dummyCancelSubscription);

export default router;
