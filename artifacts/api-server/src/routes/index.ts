import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth.js";
import inviteRouter from "./invite.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(inviteRouter);

export default router;
