import express from "express";
import { authorize } from "../middlewares/authorize.js";
import { roles } from "../config/roles.js";
import {
   adminBlock,
   adminDelete,
   adminLogout,
   changeRole,
   getAllUsers,
   getSessionStatus,
   getAdminDashboardSummary,
} from "../Controllers/rbacController.js";
import { customRateLimit } from "../middlewares/rateLimit.js";

const router = express.Router();

router.get(
  "/dashboard/summary",
  customRateLimit(1, 10),
  authorize(roles.ADMIN),
  getAdminDashboardSummary,
);

router.get("/", customRateLimit(1, 5), authorize(roles.CREATOR, roles.ADMIN), getAllUsers);

router.get(
  "/session/:id",
  customRateLimit(1, 20),
  authorize(roles.CREATOR, roles.ADMIN),
  getSessionStatus,
);

router.post(
  "/logout",
  customRateLimit(1, 1),
  authorize(roles.CREATOR, roles.ADMIN),
  adminLogout,
);

router.delete(
  "/delete",
  customRateLimit(1, 1),
  authorize(roles.ADMIN),
  adminDelete,
);

router.patch(
  "/block",
  customRateLimit(1, 5),
  authorize(roles.ADMIN),
  adminBlock,
);

router.patch(
  "/role",
  customRateLimit(1, 1),
  authorize(roles.ADMIN),
  changeRole,
);

export default router;
