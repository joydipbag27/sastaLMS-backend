import express from "express";
import { authorize } from "../middlewares/authorize.js";
import { roles } from "../config/roles.js";
import {
   adminBlock,
   adminDelete,
   adminLogout,
   promoteToCreator,
   getAllUsers,
   getSessionStatus,
   getAdminDashboardSummary,
   getAdminPaymentSummary,
   getRevenueByCourse,
   getSuccessfulPayments,
   getPaymentInvoice,
} from "../Controllers/rbacController.js";
import { customRateLimit } from "../middlewares/rateLimit.js";

const router = express.Router();

router.get(
  "/dashboard/summary",
  customRateLimit(1, 10),
  authorize(roles.CREATOR),
  getAdminDashboardSummary,
);

router.get(
  "/payments/summary",
  customRateLimit(1, 10),
  authorize(roles.CREATOR),
  getAdminPaymentSummary,
);

router.get(
  "/payments/revenue-by-course",
  customRateLimit(1, 10),
  authorize(roles.CREATOR),
  getRevenueByCourse,
);

router.get(
  "/payments/successful",
  customRateLimit(1, 10),
  authorize(roles.CREATOR),
  getSuccessfulPayments,
);

router.get(
  "/payments/:paymentId/invoice",
  customRateLimit(1, 10),
  authorize(roles.CREATOR),
  getPaymentInvoice,
);

// Returns manageable STUDENT accounts only (CREATOR accounts are excluded)
router.get("/", customRateLimit(1, 5), authorize(roles.CREATOR), getAllUsers);

router.get(
  "/session/:id",
  customRateLimit(1, 20),
  authorize(roles.CREATOR),
  getSessionStatus,
);

router.post(
  "/logout",
  customRateLimit(1, 1),
  authorize(roles.CREATOR),
  adminLogout,
);

router.delete(
  "/delete",
  customRateLimit(1, 1),
  authorize(roles.CREATOR),
  adminDelete,
);

router.patch(
  "/block",
  customRateLimit(1, 5),
  authorize(roles.CREATOR),
  adminBlock,
);

// STUDENT → CREATOR promotion — the only allowed role transition through the API.
// Promotion is irreversible through the normal API.
router.patch(
  "/users/:userId/promote",
  customRateLimit(1, 1),
  authorize(roles.CREATOR),
  promoteToCreator,
);

export default router;
